# Voicepad

A lightweight local voiceover studio for recording narration while watching a video and following timed subtitles.

[简体中文说明](README.zh-CN.md)

Voicepad runs in your browser with a small Python server on your own computer. It uses the Python standard library and browser APIs: no package installation, build step, FFmpeg, AI models, account, or cloud upload is needed. The interface is currently in Simplified Chinese.

## Features

- Play video, its original audio, timed SRT subtitles, and recorded narration together.
- Edit each subtitle's start and end time. The teleprompter shows the current line, the next line, and time remaining until a line starts or ends.
- Switch between **record mode** (existing narration muted) and **replay mode** (narration synchronized with the video). Control the video's original audio separately.
- Record continuously or one subtitle at a time. The optional **1.5-second preparation countdown** uses three dots, disappearing one every 0.5 seconds.
- Re-record, delete, and undo individual takes. Continuous recordings are split into editable subtitle and gap segments.
- Create and switch between locally saved sessions. A new session can reuse the current video and subtitles with an empty narration track.
- Export an aligned **48 kHz, 16-bit, mono WAV** containing only the recorded narration, plus an edited SRT. Silence between takes is preserved.

## Quick start

Requirements: **Python 3.10 or newer** and **Chrome or Edge**.

Download this repository as a ZIP and extract it, or clone it:

```sh
git clone https://github.com/Hyper-Duck/voicepad.git
cd voicepad
python server.py --open
```

On macOS or Linux, use `python3` if needed. On Windows, you can double-click **Start-Voicepad.cmd**.

The app opens at **http://127.0.0.1:8768**. Import your video and SRT to begin. Allow microphone access when you first record, and use headphones to keep the video's audio out of your microphone.

### Main controls

| Control | What it does |
| --- | --- |
| 导入视频 / 导入 SRT | Import a video / subtitle file |
| 新建 session | Start a fresh recording session |
| 录音模式 / 重放模式 | Record mode / replay mode |
| 开始录音 / 停止录音 | Start / stop continuous recording |
| 录这一句 / 重录这一句 | Record / replace a single subtitle's take |
| 删除录音 / 撤销删除 | Delete a take / undo the last recording change |
| 导出人声 WAV / 导出字幕 | Export narration / edited subtitles |

Click a subtitle to seek to it. Enter times as `00:01:23.456` or seconds such as `83.456`.

**Keyboard:** Space to play or pause; R to start or stop recording; Esc to cancel the preparation countdown or stop recording. Shortcuts are inactive while editing a field or using a dialog.

## Recording and editing behavior

- A per-subtitle take stops at that subtitle's end time. The previous take is replaced only after the new recording has been captured and uploaded to the local server.
- Continuous recording replaces existing narration only within the recorded interval. Audio outside that interval is retained.
- Moving a subtitle's start moves its attached recordings by the same amount. Changing its end changes the subtitle display duration without trimming the recorded audio.
- Deleting a subtitle's recording leaves other subtitles and gap recordings intact. Expand the recording list to delete individual gap segments.
- Undo retains the most recent 12 recording changes in the current page session. The underlying source WAV files remain on disk.
- Video buffering, pausing, or microphone disconnection stops recording and saves the captured portion.
- WAV exports retain their positions on the video timeline, including leading silence, and are at least as long as the video. Start the exported WAV and the video at time zero to align them.

## Local files

The app creates these folders on first run:

```text
data/
  sessions/   Session metadata and subtitle edits
  assets/     Imported videos and original recordings
  exports/    Exported WAV and SRT files
```

Imported media is copied into `data/assets`; the original files are unchanged. Sessions save automatically. Back up the entire `data` folder to preserve your work. Wait for saving to finish before closing the page or stopping the server.

The server listens only on `127.0.0.1`. Closing the browser tab leaves the small local server running; starting the launcher again reopens it. Use **Stop-Voicepad.cmd** on Windows, or Ctrl+C when running the server in a terminal, to stop it after saving.

`data/`, recordings, media, logs, local shortcuts, and generated development output are excluded from Git by `.gitignore`.

## Compatibility and limits

- The browser must support the video's codecs; H.264/AAC MP4 and WebM are recommended.
- SRT is read as UTF-8, with a GB18030 fallback for older Chinese subtitle files.
- Each imported file can be up to 2 GB. WAV export supports timelines up to two hours and uses browser memory, so longer recordings require more RAM.
- WAV export contains the microphone narration only. Mix background audio into your final video with your video editor.
- Browser microphone access requires the local server; opening `index.html` directly does not run the app.

## Development

Runtime dependencies: Python standard library and browser APIs only. Node.js 22+ is used for the core algorithm tests, not for running Voicepad.

```sh
node --test tests/core.test.mjs
python -m unittest discover -s tests -p "test_*.py"
```

Tests cover subtitle parsing and validation, recording segmentation, replacement intervals, cue movement, WAV encoding, local session persistence, HTTP media ranges, and request isolation.

```text
server.py                  Local HTTP server and disk persistence
web/index.html             Workspace layout
web/style.css              Styling
web/app.js                 Playback, recording, sessions, and export
web/core.mjs               Subtitle and audio utilities
web/recorder-worklet.js    Microphone PCM capture
tests/                     Dependency-free core and server tests
```
