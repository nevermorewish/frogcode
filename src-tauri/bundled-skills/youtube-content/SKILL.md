---
name: youtube-content
description: YouTube research and content operations — search, download, transcript extraction, and audio processing via yt-dlp.
version: 1.0.0
author: hermes-CCC (ported from Hermes Agent by NousResearch)
license: MIT
metadata:
  hermes:
    tags: [YouTube, Media, Content, Research, yt-dlp, Transcription, Download]
    related_skills: []
---

# YouTube Content

Download videos, extract transcripts, process audio, and research YouTube content with yt-dlp.

## Setup

```bash
pip install yt-dlp
# or
brew install yt-dlp
```

---

## Download Video

```bash
# Default best quality
yt-dlp "https://www.youtube.com/watch?v=VIDEO_ID"

# Best video + audio
yt-dlp -f "bestvideo+bestaudio" "URL"

# Specific resolution
yt-dlp -f "bestvideo[height<=720]+bestaudio" "URL"

# List available formats first
yt-dlp -F "URL"
```

---

## Audio Only

```bash
# MP3
yt-dlp -x --audio-format mp3 "URL"

# Best audio quality
yt-dlp -x --audio-quality 0 "URL"

# WAV for transcription
yt-dlp -x --audio-format wav "URL"
```

---

## Transcripts / Subtitles

```bash
# Download auto-generated subtitles (no video)
yt-dlp --write-auto-sub --skip-download --sub-lang en "URL"

# Download manual subtitles
yt-dlp --write-sub --sub-lang en,ko --skip-download "URL"

# Convert to readable text
yt-dlp --write-auto-sub --skip-download --sub-lang en \
  --convert-subs srt "URL"

# List available subtitle languages
yt-dlp --list-subs "URL"
```

Parse SRT to plain text:
```python
import re

with open("video.en.srt") as f:
    content = f.read()

# Remove timestamps and indices
text = re.sub(r'\d+\n\d{2}:\d{2}:\d{2}.*?\n', '', content)
text = re.sub(r'\n{2,}', '\n', text).strip()
print(text)
```

---

## Output Naming

```bash
# Custom filename
yt-dlp -o "%(title)s.%(ext)s" "URL"

# With date
yt-dlp -o "%(upload_date)s-%(title)s.%(ext)s" "URL"

# Into subdirectory
yt-dlp -o "downloads/%(uploader)s/%(title)s.%(ext)s" "URL"
```

---

## Playlists and Channels

```bash
# Full playlist
yt-dlp "https://www.youtube.com/playlist?list=PLAYLIST_ID"

# Channel (recent 20)
yt-dlp --playlist-end 20 "https://www.youtube.com/@channelname"

# Skip already downloaded
yt-dlp --download-archive downloaded.txt "PLAYLIST_URL"
```

---

## Thumbnails and Metadata

```bash
# Download thumbnail only
yt-dlp --write-thumbnail --skip-download "URL"

# Write metadata JSON
yt-dlp --write-info-json --skip-download "URL"

# Embed thumbnail in audio file
yt-dlp -x --audio-format mp3 --embed-thumbnail "URL"
```

---

## Rate Limiting (Be Polite)

```bash
# Limit download speed
yt-dlp --rate-limit 1M "URL"

# Add sleep between downloads
yt-dlp --sleep-interval 3 --max-sleep-interval 10 "PLAYLIST_URL"

# Use cookies (for age-restricted / logged-in content)
yt-dlp --cookies-from-browser chrome "URL"
```

---

## Extract Info Without Downloading

```python
import yt_dlp

ydl_opts = {"quiet": True}
with yt_dlp.YoutubeDL(ydl_opts) as ydl:
    info = ydl.extract_info("URL", download=False)
    print(info["title"])
    print(info["description"])
    print(info["duration"])  # seconds
    print(info["view_count"])
    print(info["upload_date"])
```

---

## YouTube Data API v3 (Search)

Requires API key from Google Cloud Console:

```python
import requests

API_KEY = "your-youtube-api-key"
query = "machine learning tutorial"

resp = requests.get(
    "https://www.googleapis.com/youtube/v3/search",
    params={
        "key": API_KEY,
        "q": query,
        "part": "snippet",
        "type": "video",
        "maxResults": 10,
        "order": "relevance",
    }
)

for item in resp.json()["items"]:
    print(item["id"]["videoId"], item["snippet"]["title"])
```

---

## Transcript → Summary Workflow

```bash
# 1. Download transcript
yt-dlp --write-auto-sub --skip-download --sub-lang en --convert-subs srt "URL"

# 2. Parse to plain text (see above)

# 3. Ask Claude to summarize
# "Summarize this transcript: <text>"
```
