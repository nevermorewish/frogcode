---
name: whisper
description: OpenAI Whisper for speech recognition and transcription — local inference, multiple model sizes, language detection, and subtitle generation.
version: 1.0.0
author: hermes-CCC (ported from Hermes Agent by NousResearch)
license: MIT
metadata:
  hermes:
    tags: [MLOps, Whisper, Speech-Recognition, Transcription, Audio, ASR]
    related_skills: []
---

# Whisper

## Purpose

- Use this skill for local speech-to-text transcription and subtitle generation.
- Prefer it when privacy, offline processing, or batch audio workflows matter.
- Whisper works well for meetings, podcasts, interviews, voice notes, and extracted video audio.
- It supports multilingual transcription and language detection.

## Install

- Standard Whisper package:

```bash
pip install openai-whisper
```

- Faster inference alternative:

```bash
pip install faster-whisper
```

- `faster-whisper` is often the better default for production batch jobs because it is typically faster at similar accuracy.

## Command Line Usage

- Basic CLI transcription:

```bash
whisper audio.mp3 --model medium --language en
```

- Use GPU explicitly:

```bash
whisper audio.mp3 --model medium --language en --device cuda
```

- Generate subtitles in SRT format:

```bash
whisper audio.mp3 --model medium --language en --output_format srt
```

- The CLI is a good fit for one-off transcription, shell scripts, and media preprocessing jobs.

## Python API

```python
import whisper

model = whisper.load_model("medium")
result = model.transcribe("audio.mp3")

print(result["text"])
print(result["language"])
print(result["segments"][:2])
```

- Standard load pattern:
- `import whisper`
- `model = whisper.load_model('medium')`

## What `transcribe()` Returns

- `text`: the full transcript
- `segments`: timestamped segment-level outputs
- `language`: detected or selected language code

- Example shape:

```python
{
    "text": "Full transcript text",
    "language": "en",
    "segments": [
        {"id": 0, "start": 0.0, "end": 4.5, "text": "Hello everyone"},
    ],
}
```

## Model Sizes

- `tiny`
- `base`
- `small`
- `medium`
- `large-v3`

- The tradeoff is simple:
- smaller models are faster and cheaper
- larger models are slower but more accurate

## Model Selection Guidance

- `tiny`: fast experiments and low-resource CPU runs
- `base`: simple automation on clean audio
- `small`: balanced for lightweight production tasks
- `medium`: common quality default for serious transcription
- `large-v3`: best accuracy when latency and VRAM are acceptable

## Language Selection

- Set the language when you know it:

```bash
whisper audio.mp3 --model medium --language en
```

- Explicit language hints usually improve speed and stability.
- If the language is unknown, let the model detect it.

## Language Detection

- Whisper can estimate the spoken language from audio features.
- Example pattern:

```python
import whisper

model = whisper.load_model("medium")
audio = whisper.load_audio("audio.mp3")
audio = whisper.pad_or_trim(audio)
mel = whisper.log_mel_spectrogram(audio).to(model.device)

_, probs = model.detect_language(mel)
language = max(probs, key=probs.get)
print(language)
```

- `model.detect_language(audio)` is the key workflow concept, though in practice you pass the processed spectrogram tensor.

## Subtitle Generation

- Generate `.srt` subtitles from the CLI:

```bash
whisper audio.mp3 --model medium --language en --output_format srt
```

- Subtitle outputs are useful for:
- video captions
- podcast transcripts
- lecture indexing
- searchable archives

## Batch Processing Multiple Files

- Simple shell loop:

```bash
Get-ChildItem *.mp3 | ForEach-Object {
  whisper $_.FullName --model medium --language en --output_format srt
}
```

- Python batch example:

```python
from pathlib import Path

import whisper

model = whisper.load_model("medium")

for path in Path("audio").glob("*.mp3"):
    result = model.transcribe(str(path))
    out_path = path.with_suffix(".txt")
    out_path.write_text(result["text"], encoding="utf-8")
```

- Batch processing is a common pattern for meeting folders, call archives, and downloaded media collections.

## GPU vs CPU

- GPU example from the CLI:

```bash
whisper audio.mp3 --model medium --device cuda
```

- GPU is strongly preferred for:
- `medium`
- `large-v3`
- multi-file batch jobs

- CPU is acceptable for:
- `tiny`
- `base`
- occasional short clips

## Common Use Cases

- YouTube audio transcription after extracting audio from video
- meeting notes from Zoom or Teams recordings
- podcast transcription for search and republishing
- lecture indexing and subtitle generation
- multilingual voice note transcription

## `faster-whisper`

- Install with:

```bash
pip install faster-whisper
```

- It is often around 4x faster while maintaining comparable accuracy.
- It is a strong choice for MLOps pipelines where throughput matters.

## `faster-whisper` Example

```python
from faster_whisper import WhisperModel

model = WhisperModel("medium", device="cuda", compute_type="float16")
segments, info = model.transcribe("audio.mp3", beam_size=5)

print(info.language, info.language_probability)

for segment in segments:
    print(f"[{segment.start:.2f} -> {segment.end:.2f}] {segment.text}")
```

- `faster-whisper` is particularly useful for server-side or queue-based transcription systems.

## Output Management

- Save plain text for downstream NLP.
- Save SRT for subtitles and media players.
- Save structured segments for search, speaker labeling pipelines, or analytics.

## Segment-Level Workflows

- Segment timestamps make it easy to:
- jump to precise moments in media
- chunk transcripts for embeddings
- build searchable meeting or lecture interfaces
- align captions with edited video

## Quality Tips

- Use the cleanest source audio available.
- Downmix weird multi-channel recordings if channels are corrupted or imbalanced.
- Remove long leading silence when possible.
- Pick a larger model for noisy audio, accents, or technical vocabulary.

## Common Failure Modes

- Slow runtime:
- switch to `faster-whisper`
- move from CPU to GPU
- use a smaller model

- Bad language choice:
- set `--language en` or another known language explicitly
- inspect the detected language before large batch runs

- Poor transcript quality:
- upgrade from `base` or `small` to `medium` or `large-v3`
- improve the source audio
- split very long recordings into manageable chunks

- Memory issues:
- use a smaller model
- run on GPU with enough VRAM
- use `faster-whisper` with a suitable compute type

## Recommended Workflow

- Start with `medium` for general English transcription.
- Move to `large-v3` when quality matters more than speed.
- Use `faster-whisper` for production batch jobs.
- Save both transcript text and structured segments.

## When To Use This Skill

- You need local transcription rather than a hosted ASR API.
- You want subtitle files for recorded media.
- You need multilingual speech recognition with no cloud dependency.
- You are building meeting, media, or archival transcription pipelines.

## Quick Reference

- Install: `pip install openai-whisper`
- Faster option: `pip install faster-whisper`
- CLI: `whisper audio.mp3 --model medium --language en`
- GPU: `--device cuda`
- SRT subtitles: `--output_format srt`
- Python load: `model = whisper.load_model("medium")`
- Result fields: `text`, `segments`, `language`
