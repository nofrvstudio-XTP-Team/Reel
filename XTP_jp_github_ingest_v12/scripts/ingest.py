#!/usr/bin/env python3
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time

import boto3
from botocore.exceptions import ClientError

ROOT = pathlib.Path(__file__).resolve().parents[1]
CFG_PATH = ROOT / "xtp-config.json"


def run(cmd, *, capture=False, check=True):
    print("+", " ".join(map(str, cmd)), flush=True)
    return subprocess.run(
        list(map(str, cmd)),
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
        check=check,
    )


def load_config():
    with CFG_PATH.open("r", encoding="utf-8") as f:
        cfg = json.load(f)
    channels = [str(x).strip() for x in cfg.get("channels", []) if str(x).strip()]
    if not channels:
        raise SystemExit("xtp-config.json: channels is empty")
    return cfg, channels


def ytdlp_base():
    args = [
        "yt-dlp",
        "--ignore-config",
        "--js-runtimes", "node",
        "--extractor-args", "youtube:player-client=mweb",
        "--retries", "10",
        "--fragment-retries", "10",
        "--retry-sleep", "http:linear=2::10",
        "--sleep-requests", "1",
    ]
    cookie_file = os.getenv("YOUTUBE_COOKIES_FILE", "").strip()
    if cookie_file and pathlib.Path(cookie_file).exists():
        args += ["--cookies", cookie_file]
    proxy = os.getenv("YTDLP_PROXY", "").strip()
    if proxy:
        args += ["--proxy", proxy]
    return args


def channel_videos_url(raw):
    raw = raw.rstrip("/")
    if raw.endswith("/videos"):
        return raw
    if "youtube.com/" in raw:
        return raw + "/videos"
    return raw


def list_latest(channel, limit):
    cmd = ytdlp_base() + [
        "--flat-playlist",
        "--playlist-end", str(limit),
        "--print", "%(id)s\t%(title)s",
        channel_videos_url(channel),
    ]
    p = run(cmd, capture=True, check=False)
    if p.returncode != 0:
        print(p.stderr or "channel listing failed", file=sys.stderr)
        return []
    out = []
    for line in (p.stdout or "").splitlines():
        parts = line.split("\t", 1)
        video_id = parts[0].strip()
        title = parts[1].strip() if len(parts) > 1 else ""
        if len(video_id) == 11:
            out.append((video_id, title))
    return out


def make_s3():
    account = os.environ["R2_ACCOUNT_ID"].strip()
    access = os.environ["R2_ACCESS_KEY_ID"].strip()
    secret = os.environ["R2_SECRET_ACCESS_KEY"].strip()
    return boto3.client(
        "s3",
        endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
        aws_access_key_id=access,
        aws_secret_access_key=secret,
        region_name="auto",
    )


def object_exists(s3, bucket, key):
    try:
        s3.head_object(Bucket=bucket, Key=key)
        return True
    except ClientError as e:
        code = str(e.response.get("Error", {}).get("Code", ""))
        status = e.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        if code in {"404", "NoSuchKey", "NotFound"} or status == 404:
            return False
        raise


def probe_duration(video_id):
    cmd = ytdlp_base() + [
        "--no-playlist",
        "--skip-download",
        "--print", "%(duration)s",
        f"https://www.youtube.com/watch?v={video_id}",
    ]
    p = run(cmd, capture=True, check=False)
    if p.returncode != 0:
        return None
    try:
        return float((p.stdout or "").strip().splitlines()[-1])
    except Exception:
        return None


def download_source(video_id, workdir):
    outtmpl = str(workdir / f"{video_id}.%(ext)s")
    cmd = ytdlp_base() + [
        "--no-playlist",
        "--concurrent-fragments", "4",
        "-S", "res:720,vcodec:h264,acodec:aac",
        "-f", "bv*+ba/b",
        "--merge-output-format", "mp4",
        "-o", outtmpl,
        f"https://www.youtube.com/watch?v={video_id}",
    ]
    run(cmd)
    candidates = sorted(workdir.glob(f"{video_id}.*"), key=lambda p: p.stat().st_size, reverse=True)
    candidates = [p for p in candidates if p.suffix.lower() not in {".part", ".ytdl", ".json"}]
    if not candidates:
        raise RuntimeError(f"yt-dlp produced no media file for {video_id}")
    return candidates[0]


def normalize_for_mobile(src, dst):
    # Always normalize once: H.264 + AAC + <=720p + faststart gives predictable iOS/Android playback.
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(src),
        "-map", "0:v:0", "-map", "0:a:0?",
        "-vf", "scale=-2:min(720\\,ih)",
        "-c:v", "libx264", "-profile:v", "high", "-level", "4.0",
        "-preset", "veryfast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        str(dst),
    ]
    run(cmd)


def upload(s3, bucket, video_id, path):
    key = f"youtube/{video_id}.mp4"
    print(f"Uploading {path.name} -> s3://{bucket}/{key}", flush=True)
    s3.upload_file(
        str(path),
        bucket,
        key,
        ExtraArgs={
            "ContentType": "video/mp4",
            "CacheControl": "public, max-age=31536000, immutable",
        },
    )


def main():
    cfg, channels = load_config()
    bucket = os.getenv("R2_BUCKET", "xtp-native-media").strip() or "xtp-native-media"
    scan_limit = max(1, min(50, int(cfg.get("scanLatestPerChannel", 12))))
    max_new = max(1, min(10, int(os.getenv("MAX_NEW_PER_RUN") or cfg.get("maxNewPerRun", 2))))
    max_duration = max(60, int(cfg.get("maxDurationSeconds", 1800)))
    s3 = make_s3()

    candidates = []
    seen = set()
    for channel in channels:
        print(f"Scanning {channel}", flush=True)
        for video_id, title in list_latest(channel, scan_limit):
            if video_id not in seen:
                candidates.append((video_id, title, channel))
                seen.add(video_id)
        time.sleep(2)

    new_count = 0
    failed = 0
    for video_id, title, channel in candidates:
        key = f"youtube/{video_id}.mp4"
        if object_exists(s3, bucket, key):
            print(f"SKIP exists {video_id} {title}", flush=True)
            continue
        if new_count >= max_new:
            break

        duration = probe_duration(video_id)
        if duration and duration > max_duration:
            print(f"SKIP duration {duration:.0f}s > {max_duration}s: {video_id} {title}", flush=True)
            continue

        try:
            with tempfile.TemporaryDirectory(prefix=f"xtp-{video_id}-") as td:
                td = pathlib.Path(td)
                raw = download_source(video_id, td)
                final = td / f"{video_id}.mobile.mp4"
                normalize_for_mobile(raw, final)
                upload(s3, bucket, video_id, final)
                print(f"OK {video_id} {title}", flush=True)
                new_count += 1
        except Exception as e:
            failed += 1
            print(f"FAIL {video_id} {title}: {e}", file=sys.stderr, flush=True)
        time.sleep(5)

    print(f"DONE uploaded={new_count} failed={failed} scanned={len(candidates)}", flush=True)
    if failed and not new_count:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
