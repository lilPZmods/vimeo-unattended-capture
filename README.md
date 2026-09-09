# Unattended Vimeo Capture for macOS

This project plays public or otherwise authorized Vimeo videos through an OBS Browser Source and records them one at a time at normal playback speed. One terminal command runs the entire queue without mouse clicks or supervision.

It does not use `yt-dlp`, rotate IP addresses, extract Vimeo media URLs, or bypass video access controls. A video must be playable in Vimeo's embedded player. Use it only for material you are authorized to record and present.

## What the automation does

1. Reads `clips.txt` in order.
2. Launches OBS when configured to do so.
3. Creates a dedicated OBS scene and Browser Source if they do not already exist.
4. Loads the Vimeo video into the Browser Source.
5. Waits until Vimeo reports that the video and its metadata are ready.
6. Starts OBS recording.
7. Starts playback with audio at full volume.
8. Stops recording when Vimeo reports that playback ended.
9. Remuxes the OBS recording into an MP4 without re-encoding.
10. Verifies that the result contains video, contains audio, and has a sensible duration.
11. Measures the audio level and warns if the audio appears silent.
12. Records successful work in `capture-state.json`, records failures in `failed-captures.json`, and generates `playlist.m3u8`.

## Requirements

- macOS
- OBS Studio 30 or newer
- Node.js 20 or newer
- FFmpeg and FFprobe
- Internet access
- Vimeo videos that permit embedded playback

Check the installed versions:

```bash
obs_version="$(mdls -name kMDItemVersion -raw /Applications/OBS.app 2>/dev/null)"; node_version="$(node --version 2>/dev/null)"; ffmpeg_version="$(ffmpeg -version 2>/dev/null | head -1)"; printf 'OBS: %s\nNode: %s\nFFmpeg: %s\n' "$obs_version" "$node_version" "$ffmpeg_version"
```

Install missing command-line requirements with Homebrew:

```bash
brew install node ffmpeg
```

OBS Studio is available from <https://obsproject.com/download>.

## 1. Put the project in your VimeoPlaylist folder

The recommended location is:

```text
~/Downloads/VimeoPlaylist/vimeo-unattended-capture/
```

Open Terminal and enter the project directory:

```bash
cd "$HOME/Downloads/VimeoPlaylist/vimeo-unattended-capture"
```

## 2. Install the Node dependency

Run this once inside the project directory:

```bash
npm install
```

This installs `obs-websocket-js`, which talks to OBS's built-in WebSocket server.

## 3. Enable OBS WebSocket

1. Open OBS.
2. Choose **Tools → WebSocket Server Settings**.
3. Enable **Enable WebSocket server**.
4. Leave the port set to `4455`.
5. Enable authentication.
6. Create or copy the WebSocket password.
7. Click **Apply**, then **OK**.

The WebSocket server is built into OBS Studio 28 and later. Keep it bound to the local computer; the capture script connects to `127.0.0.1` only.

## 4. Configure the project

Create your working configuration:

```bash
cp config.example.json config.json
open -e config.json
```

Replace:

```json
"password": "REPLACE_WITH_YOUR_OBS_WEBSOCKET_PASSWORD"
```

with the password from OBS. Preserve the quotation marks. Save and close the file.

The default configuration creates these OBS items automatically:

```text
Scene:          Vimeo Capture Automation
Browser Source: Vimeo Capture Browser
Resolution:     1920 × 1080
```

Do not create them manually unless you want to inspect the setup in advance.

## 5. Configure OBS recording once

Open **OBS → Settings**.

### Video

Set:

```text
Base (Canvas) Resolution:   1920x1080
Output (Scaled) Resolution: 1920x1080
Common FPS Value:           30
```

### Output → Recording

Recommended settings:

```text
Recording Format: Matroska Video (.mkv)
Video Encoder:    Apple VT H264 Hardware Encoder
Audio Encoder:    CoreAudio AAC
Audio Track:      1
```

Choose an OBS temporary recording directory with enough free space. The script obtains the actual path of every recording from OBS, validates the final MP4, and then deletes the temporary file when `deleteRawAfterSuccess` is `true`.

MKV is recommended because an interrupted recording remains recoverable. The script remuxes it to MP4 without transcoding.

Click **Apply**, then **OK**.

## 6. Create the URL list

If `clips.txt` already exists in the parent `VimeoPlaylist` directory, copy it into this project:

```bash
cp "$HOME/Downloads/VimeoPlaylist/clips.txt" "$HOME/Downloads/VimeoPlaylist/vimeo-unattended-capture/clips.txt"
```

Otherwise:

```bash
cp clips.example.txt clips.txt
open -e clips.txt
```

Use one Vimeo URL per line:

```text
https://vimeo.com/855884611
https://vimeo.com/123456789
https://vimeo.com/987654321
```

Blank lines and lines beginning with `#` are ignored. The script also cleans up Markdown links accidentally pasted in this form:

```text
[https://vimeo.com/855884611](https://vimeo.com/855884611)
```

## 7. Run the setup doctor

Quit any recording currently running in OBS. Then run:

```bash
cd "$HOME/Downloads/VimeoPlaylist/vimeo-unattended-capture"
npm run doctor
```

The doctor checks:

- FFmpeg and FFprobe
- `clips.txt`
- OBS WebSocket connection and password
- Whether OBS is already recording
- Dedicated scene creation
- Browser Source creation
- Browser Source audio rerouting

Success ends with a `doctor.success` log entry.

## 8. Perform a one-video test

Run:

```bash
cd "$HOME/Downloads/VimeoPlaylist/vimeo-unattended-capture"
caffeinate -dimsu npm run test-one
```

The first uncaptured video will play at normal speed and produce an MP4 in:

```text
~/Downloads/VimeoPlaylist/vimeo-unattended-capture/captures/
```

Open it:

```bash
open "$HOME/Downloads/VimeoPlaylist/vimeo-unattended-capture/captures"
```

Confirm the picture and audio before running the full queue.

## 9. Run the complete unattended queue

Run:

```bash
cd "$HOME/Downloads/VimeoPlaylist/vimeo-unattended-capture"
caffeinate -dimsu npm start
```

You may minimize OBS and Terminal. `caffeinate` prevents the Mac and display from sleeping while the queue runs. You do not need to watch or click anything.

Do not close OBS, quit Terminal, change the active OBS scene, or start another OBS recording while the queue is running. You may continue using other applications because the script records the OBS Browser Source rather than the desktop.

## Results

Successful MP4 files:

```text
captures/
```

VLC playlist:

```text
playlist.m3u8
```

Open the playlist:

```bash
open -a VLC "$HOME/Downloads/VimeoPlaylist/vimeo-unattended-capture/playlist.m3u8"
```

Persistent completion state:

```text
capture-state.json
```

Current failure report:

```text
failed-captures.json
```

Detailed structured log:

```text
logs/capture.log
```

Raw recordings that were preserved after a failed capture:

```text
captures/_failed_raw/
```

## Resuming after interruption

Run the same command again:

```bash
caffeinate -dimsu npm start
```

The script skips every validated file recorded in `capture-state.json` and retries unfinished or failed URLs. It rewrites `playlist.m3u8` after each successful capture.

Pressing `Control-C` asks OBS to stop any active recording before the script exits. An interrupted raw recording is retained by OBS for recovery.

## Changing capture quality

The Browser Source size is controlled by `config.json`:

```json
"width": 1920,
"height": 1080
```

OBS controls the actual recording codec, bitrate, quality, frame rate, and output resolution. For presentation playback, H.264 video plus AAC audio in MP4 is the most broadly compatible combination.

## Audio validation

Every output must contain an audio stream by default:

```json
"failWhenAudioStreamMissing": true
```

The script also measures the mean audio level. It logs a warning when the level is at or below `-70 dB`:

```json
"silentAudioThresholdDb": -70
```

Some legitimate art videos may be intentionally silent, so silence is only a warning by default:

```json
"failWhenAudioIsSilent": false
```

Change that value to `true` if every source is expected to contain audible sound.

## Troubleshooting

### OBS WebSocket connection fails

Confirm OBS is open and **Tools → WebSocket Server Settings → Enable WebSocket server** is enabled. Confirm the port is `4455` and the password exactly matches `config.json`.

### Video loads but no audio appears in the recording

Open the `Vimeo Capture Automation` scene. In the Audio Mixer, confirm `Vimeo Capture Browser` is present, unmuted, and its meter moves while the test video plays.

Open **Advanced Audio Properties** and confirm Track 1 is checked for `Vimeo Capture Browser`. The script requests Track 1 automatically, but checking it manually identifies OBS profile-specific problems.

Do not add BlackHole, Desktop Audio, or a microphone source for this workflow. Browser audio should be routed directly into OBS.

### The resulting MP4 has an audio track but it is silent

Look for `validateRecording.silentAudio` in `logs/capture.log`. Test the Vimeo URL in a normal browser. If it has audible sound there, inspect the Browser Source audio meter in OBS and confirm **Control audio via OBS** is enabled in the Browser Source properties.

### A video reports a privacy or embedding error

The uploader has disabled embedding or restricted it to approved domains. This workflow intentionally does not bypass that restriction. The URL remains in `failed-captures.json`.

### OBS produces a recording that cannot be remuxed

Use the recommended H.264 video and AAC audio encoders. The original OBS file is preserved in `captures/_failed_raw/` whenever capture or validation fails.

### The video never ends

The script calculates a watchdog timeout from Vimeo's reported duration, with five additional minutes for buffering. The failed attempt is stopped safely and may be retried once. Adjust these values in `config.json` if the connection is unusually slow:

```json
"maximumExtraTimeMs": 300000,
"maxAttempts": 2,
"retryDelayMs": 30000
```

### Port 8765 is already in use

Change the server port in `config.json`:

```json
"port": 8766
```

### The script says OBS is already recording

Stop the existing OBS recording. The script refuses to stop or overwrite a recording that it did not start.

## Important operational notes

- Captures run sequentially and require approximately the combined duration of the videos.
- OBS must remain open.
- The Mac must remain awake; use the provided `caffeinate` command.
- The internet connection must remain available.
- A video must permit playback through Vimeo's embedded player.
- `deleteRawAfterSuccess` deletes only the temporary OBS recording after a validated MP4 has been created.
- Do not manually edit `capture-state.json` while the script is running.
- Keep enough disk space for one temporary OBS recording plus the completed MP4 files.

## Stop and restart from the beginning

Normally you should not reset because the resume file prevents duplicate work. If you intentionally want a fresh queue, move the state file aside instead of deleting it:

```bash
cd "$HOME/Downloads/VimeoPlaylist/vimeo-unattended-capture"
mv capture-state.json "capture-state.$(date +%Y%m%d-%H%M%S).backup.json"
```

Existing MP4 files are not deleted.
