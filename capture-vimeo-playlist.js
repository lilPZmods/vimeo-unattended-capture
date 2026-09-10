#!/usr/bin/env node

import {createServer} from 'node:http';
import {EventEmitter} from 'node:events';
import {spawn, spawnSync} from 'node:child_process';
import {createReadStream, existsSync} from 'node:fs';
import {
  access,
  appendFile,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import {constants as fsConstants} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import OBSWebSocket from 'obs-websocket-js';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PLAYER_FILE = path.join(SCRIPT_DIRECTORY, 'player.html');
const argumentsList = process.argv.slice(2);
const DOCTOR_MODE = argumentsList.includes('--doctor');
const limitArgumentIndex = argumentsList.indexOf('--limit');
const JOB_LIMIT = limitArgumentIndex >= 0
  ? Number.parseInt(argumentsList[limitArgumentIndex + 1], 10)
  : Number.POSITIVE_INFINITY;

class Logger {
  constructor(logDirectory) {
    this.logDirectory = logDirectory;
    this.logFile = path.join(logDirectory, 'capture.log');
    this.meta = new Map();
  }

  async initialize() {
    const started = performance.now();
    await mkdir(this.logDirectory, {recursive: true});
    await this.info('logger.initialize', {logFile: this.logFile});
    this.recordTiming('logger.initialize', started);
  }

  async write(level, event, details = {}) {
    const record = {
      timestamp: new Date().toISOString(),
      level,
      event,
      ...details
    };
    const line = JSON.stringify(record);
    console.log(`[${record.timestamp}] [${level}] ${event}`, details);
    await appendFile(this.logFile, `${line}\n`, 'utf8');
  }

  async info(event, details = {}) {
    await this.write('INFO', event, details);
  }

  async warn(event, details = {}) {
    await this.write('WARN', event, details);
  }

  async error(event, details = {}) {
    await this.write('ERROR', event, details);
  }

  recordTiming(name, startedAt) {
    const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
    const current = this.meta.get(name) || {calls: 0, totalMs: 0, maxMs: 0};
    current.calls += 1;
    current.totalMs += durationMs;
    current.maxMs = Math.max(current.maxMs, durationMs);
    this.meta.set(name, current);
    return durationMs;
  }

  async timed(name, operation) {
    const started = performance.now();
    await this.info(`${name}.start`);
    try {
      const result = await operation();
      const durationMs = this.recordTiming(name, started);
      await this.info(`${name}.complete`, {durationMs});
      return result;
    } catch (error) {
      const durationMs = this.recordTiming(name, started);
      await this.error(`${name}.failed`, {durationMs, error: errorMessage(error)});
      throw error;
    }
  }

  async writeMetaTimeRunLog() {
    const summary = [...this.meta.entries()].map(([operation, value]) => ({
      operation,
      calls: value.calls,
      totalMs: Math.round(value.totalMs * 100) / 100,
      averageMs: Math.round((value.totalMs / value.calls) * 100) / 100,
      maxMs: Math.round(value.maxMs * 100) / 100
    }));
    await this.info('MetaTimeRunLog', {operations: summary});
  }
}

class CaptureChannel {
  constructor(token, logger) {
    this.token = token;
    this.logger = logger;
    this.events = new EventEmitter();
    this.latest = new Map();
    this.controlResponse = null;
    this.timers = new Set();
  }

  async publish(type, data) {
    await this.logger.info('browser.event', {token: this.token, type, data});
    this.latest.set(type, data);
    this.events.emit(type, data);
  }

  waitFor(type, timeoutMs = null) {
    const started = performance.now();
    this.logger.info('channel.waitFor.start', {token: this.token, type, timeoutMs});
    if (this.latest.has(type)) {
      this.logger.recordTiming(`channel.waitFor.${type}`, started);
      return Promise.resolve(this.latest.get(type));
    }

    return new Promise((resolve, reject) => {
      let timer = null;
      if (timeoutMs != null) {
        timer = setTimeout(() => {
          this.timers.delete(timer);
          this.events.removeListener(type, handler);
          this.logger.recordTiming(`channel.waitFor.${type}`, started);
          reject(new Error(`Timed out after ${timeoutMs} ms waiting for browser event: ${type}`));
        }, timeoutMs);
        this.timers.add(timer);
      }
      const handler = data => {
        if (timer) {
          clearTimeout(timer);
          this.timers.delete(timer);
        }
        this.logger.recordTiming(`channel.waitFor.${type}`, started);
        resolve(data);
      };
      this.events.once(type, handler);
    });
  }

  attachControl(response) {
    const started = performance.now();
    this.logger.info('channel.attachControl.start', {token: this.token});
    this.controlResponse = response;
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    });
    response.write(': connected\n\n');
    this.publish('controlConnected', {connected: true});
    this.logger.recordTiming('channel.attachControl', started);
  }

  async sendCommand(action) {
    const started = performance.now();
    await this.logger.info('channel.sendCommand.start', {token: this.token, action});
    if (!this.controlResponse || this.controlResponse.destroyed) {
      throw new Error('The browser control connection is not available');
    }
    this.controlResponse.write(`event: command\ndata: ${JSON.stringify({action})}\n\n`);
    const durationMs = this.logger.recordTiming('channel.sendCommand', started);
    await this.logger.info('channel.sendCommand.complete', {token: this.token, action, durationMs});
  }

  close() {
    const started = performance.now();
    this.logger.info('channel.close.start', {token: this.token});
    this.controlResponse?.end();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.events.removeAllListeners();
    this.logger.recordTiming('channel.close', started);
  }
}

class CaptureServer {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.channels = new Map();
    this.server = null;
  }

  createChannel(token) {
    const started = performance.now();
    const channel = new CaptureChannel(token, this.logger);
    this.channels.set(token, channel);
    this.logger.recordTiming('server.createChannel', started);
    this.logger.info('server.createChannel', {token});
    return channel;
  }

  removeChannel(token) {
    const started = performance.now();
    this.channels.get(token)?.close();
    this.channels.delete(token);
    this.logger.recordTiming('server.removeChannel', started);
    this.logger.info('server.removeChannel', {token});
  }

  async start() {
    return this.logger.timed('server.start', async () => {
      const playerHtml = await readFile(PLAYER_FILE);
      this.server = createServer(async (request, response) => {
        try {
          const requestUrl = new URL(request.url, this.baseUrl());

          if (request.method === 'GET' && requestUrl.pathname === '/health') {
            response.writeHead(200, {'content-type': 'application/json'});
            response.end(JSON.stringify({ok: true}));
            return;
          }

          if (request.method === 'GET' && requestUrl.pathname === '/player') {
            response.writeHead(200, {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-store'
            });
            response.end(playerHtml);
            return;
          }

          if (request.method === 'GET' && requestUrl.pathname === '/control') {
            const channel = this.channels.get(requestUrl.searchParams.get('token'));
            if (!channel) {
              response.writeHead(404);
              response.end('Unknown capture token');
              return;
            }
            channel.attachControl(response);
            return;
          }

          if (request.method === 'POST' && requestUrl.pathname === '/event') {
            const body = await readJsonBody(request);
            const channel = this.channels.get(body.token);
            if (!channel) {
              response.writeHead(404);
              response.end(JSON.stringify({ok: false, error: 'Unknown capture token'}));
              return;
            }
            await channel.publish(body.type, body.data || {});
            response.writeHead(200, {'content-type': 'application/json'});
            response.end(JSON.stringify({ok: true}));
            return;
          }

          response.writeHead(404);
          response.end('Not found');
        } catch (error) {
          await this.logger.error('server.request.failed', {error: errorMessage(error)});
          if (!response.headersSent) response.writeHead(500);
          response.end('Internal server error');
        }
      });

      await new Promise((resolve, reject) => {
        this.server.once('error', reject);
        this.server.listen(this.config.server.port, this.config.server.host, resolve);
      });
      await this.logger.info('server.listening', {url: this.baseUrl()});
    });
  }

  baseUrl() {
    const started = performance.now();
    const url = `http://${this.config.server.host}:${this.config.server.port}`;
    this.logger.recordTiming('server.baseUrl', started);
    return url;
  }

  async stop() {
    return this.logger.timed('server.stop', async () => {
      for (const token of this.channels.keys()) this.removeChannel(token);
      if (!this.server) return;
      await new Promise(resolve => this.server.close(resolve));
      this.server = null;
    });
  }
}

function errorMessage(error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  return message;
}

function expandHome(inputPath) {
  if (inputPath === '~') return process.env.HOME;
  if (inputPath.startsWith('~/')) return path.join(process.env.HOME, inputPath.slice(2));
  return inputPath;
}

function resolveConfiguredPath(inputPath) {
  const expanded = expandHome(inputPath);
  return path.isAbsolute(expanded) ? expanded : path.join(SCRIPT_DIRECTORY, expanded);
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function sanitizeFilename(value) {
  const cleaned = String(value || 'Untitled Vimeo Video')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/:]/g, ' - ')
    .replace(/[?*"<>|\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '');
  return (cleaned || 'Untitled Vimeo Video').slice(0, 160);
}

function normalizeVimeoUrl(line) {
  const markdownMatch = line.match(/\]\((https?:\/\/(?:www\.)?(?:player\.)?vimeo\.com\/[^)\s]+)\)/i);
  const directMatch = line.match(/https?:\/\/(?:www\.)?(?:player\.)?vimeo\.com\/[^\s<>)\]]+/i);
  const candidate = markdownMatch?.[1] || directMatch?.[0];
  if (!candidate) throw new Error(`No Vimeo URL found in line: ${line}`);
  const url = new URL(candidate);
  url.hash = '';
  return url.toString();
}

function vimeoIdFromUrl(url) {
  const matches = [...new URL(url).pathname.matchAll(/(?:^|\/)(\d+)(?:\/|$)/g)];
  return matches.length ? matches.at(-1)[1] : 'unknown';
}

async function readJsonBody(request) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > 1_000_000) throw new Error('HTTP JSON body exceeded 1 MB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function loadConfig() {
  const started = performance.now();
  const configPath = path.join(SCRIPT_DIRECTORY, 'config.json');
  if (!existsSync(configPath)) {
    throw new Error('config.json is missing. Run: cp config.example.json config.json');
  }
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.paths = Object.fromEntries(
    Object.entries(config.files).map(([key, value]) => [key, resolveConfiguredPath(value)])
  );
  globalLogger?.recordTiming('loadConfig', started);
  await globalLogger?.info('loadConfig.complete', {configPath});
  return config;
}

async function loadState(statePath) {
  return globalLogger.timed('loadState', async () => {
    if (!existsSync(statePath)) return {version: 1, completed: {}, failures: {}};
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    state.completed ||= {};
    state.failures ||= {};
    return state;
  });
}

async function saveState(statePath, state) {
  return globalLogger.timed('saveState', async () => {
    const temporaryPath = `${statePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, statePath);
  });
}

async function loadJobs(inputPath) {
  return globalLogger.timed('loadJobs', async () => {
    const text = await readFile(inputPath, 'utf8');
    const jobs = [];
    const seen = new Set();
    for (const [lineIndex, rawLine] of text.split(/\r?\n/).entries()) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      try {
        const url = normalizeVimeoUrl(line);
        if (seen.has(url)) {
          await globalLogger.warn('loadJobs.duplicate', {line: lineIndex + 1, url});
          continue;
        }
        seen.add(url);
        jobs.push({index: jobs.length + 1, sourceLine: lineIndex + 1, url});
      } catch (error) {
        await globalLogger.warn('loadJobs.invalidLine', {
          line: lineIndex + 1,
          value: line,
          error: errorMessage(error)
        });
      }
    }
    if (!jobs.length) throw new Error(`No valid Vimeo URLs were found in ${inputPath}`);
    return jobs;
  });
}

function commandExists(command) {
  const started = performance.now();
  const result = spawnSync('/usr/bin/env', ['which', command], {encoding: 'utf8'});
  globalLogger?.recordTiming(`commandExists.${command}`, started);
  globalLogger?.info('commandExists', {
    command,
    found: result.status === 0,
    path: result.stdout.trim() || null
  });
  return result.status === 0;
}

async function launchObsIfRequested(config) {
  return globalLogger.timed('launchObsIfRequested', async () => {
    if (!config.obs.launchObs) return;
    const child = spawn('/usr/bin/open', ['-a', 'OBS'], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    await globalLogger.info('obs.launch.requested');
  });
}

async function connectObs(config, obs) {
  return globalLogger.timed('connectObs', async () => {
    const deadline = Date.now() + 90_000;
    let lastError;
    while (Date.now() < deadline) {
      try {
        const result = await obs.connect(config.obs.address, config.obs.password || undefined);
        await globalLogger.info('obs.connected', {
          address: config.obs.address,
          negotiatedRpcVersion: result.negotiatedRpcVersion
        });
        return result;
      } catch (error) {
        lastError = error;
        await globalLogger.warn('obs.connect.retry', {error: errorMessage(error)});
        await sleep(3000);
      }
    }
    throw new Error(`Could not connect to OBS within 90 seconds: ${errorMessage(lastError)}`);
  });
}

async function ensureObsSceneAndSource(obs, config, server) {
  return globalLogger.timed('ensureObsSceneAndSource', async () => {
    const sceneName = config.obs.sceneName;
    const inputName = config.obs.browserSourceName;
    const sceneList = await obs.call('GetSceneList');
    if (!sceneList.scenes.some(scene => scene.sceneName === sceneName)) {
      await obs.call('CreateScene', {sceneName});
      await globalLogger.info('obs.scene.created', {sceneName});
    }

    const inputList = await obs.call('GetInputList');
    if (!inputList.inputs.some(input => input.inputName === inputName)) {
      await obs.call('CreateInput', {
        sceneName,
        inputName,
        inputKind: 'browser_source',
        inputSettings: {
          url: `${server.baseUrl()}/health`,
          width: config.capture.width,
          height: config.capture.height,
          reroute_audio: true,
          shutdown: false,
          restart_when_active: true
        },
        sceneItemEnabled: true
      });
      await globalLogger.info('obs.browserSource.created', {inputName});
    } else {
      try {
        await obs.call('GetSceneItemId', {sceneName, sourceName: inputName});
      } catch {
        await obs.call('CreateSceneItem', {
          sceneName,
          sourceName: inputName,
          sceneItemEnabled: true
        });
        await globalLogger.info('obs.browserSource.addedToScene', {sceneName, inputName});
      }
    }

    const settings = await obs.call('GetInputSettings', {inputName});
    if (settings.inputKind !== 'browser_source') {
      throw new Error(`OBS input "${inputName}" exists but is ${settings.inputKind}, not browser_source`);
    }

    await obs.call('SetInputSettings', {
      inputName,
      inputSettings: {
        url: `${server.baseUrl()}/health`,
        width: config.capture.width,
        height: config.capture.height,
        reroute_audio: true,
        shutdown: false,
        restart_when_active: true
      },
      overlay: true
    });

    const {sceneItemId} = await obs.call('GetSceneItemId', {sceneName, sourceName: inputName});
    await obs.call('SetSceneItemEnabled', {sceneName, sceneItemId, sceneItemEnabled: true});
    await obs.call('SetSceneItemTransform', {
      sceneName,
      sceneItemId,
      sceneItemTransform: {
        positionX: 0,
        positionY: 0,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        cropLeft: 0,
        cropRight: 0,
        cropTop: 0,
        cropBottom: 0,
        boundsType: 'OBS_BOUNDS_STRETCH',
        boundsWidth: config.capture.width,
        boundsHeight: config.capture.height,
        boundsAlignment: 0
      }
    });

    await obs.call('SetInputMute', {inputName, inputMuted: false});
    await obs.call('SetInputVolume', {inputName, inputVolumeMul: 1});
    try {
      await obs.call('SetInputAudioTracks', {
        inputName,
        inputAudioTracks: {'1': true, '2': false, '3': false, '4': false, '5': false, '6': false}
      });
    } catch (error) {
      await globalLogger.warn('obs.audioTracks.configure.failed', {error: errorMessage(error)});
    }

    const previousSceneName = sceneList.currentProgramSceneName;
    await obs.call('SetCurrentProgramScene', {sceneName});
    await globalLogger.info('obs.captureScene.active', {sceneName, previousSceneName});
    return {previousSceneName};
  });
}

async function ensureNotRecording(obs) {
  return globalLogger.timed('ensureNotRecording', async () => {
    const status = await obs.call('GetRecordStatus');
    if (status.outputActive) {
      throw new Error('OBS is already recording. Stop that recording before starting this automation.');
    }
  });
}

async function runCommand(command, args, eventName) {
  return globalLogger.timed(eventName, async () => {
    await globalLogger.info(`${eventName}.command`, {command, args});
    const result = spawnSync(command, args, {encoding: 'utf8'});
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`${command} exited with status ${result.status}: ${result.stderr || result.stdout}`);
    }
    return result;
  });
}

async function remuxRecording(rawPath, outputPath) {
  return globalLogger.timed('remuxRecording', async () => {
    await mkdir(path.dirname(outputPath), {recursive: true});
    const temporaryPath = `${outputPath}.${randomUUID()}.part.mp4`;
    try {
      await runCommand('ffmpeg', [
        '-hide_banner',
        '-loglevel', 'error',
        '-y',
        '-i', rawPath,
        '-map', '0:v:0',
        '-map', '0:a:0?',
        '-c', 'copy',
        '-movflags', '+faststart',
        temporaryPath
      ], 'ffmpeg.remux');
      await rename(temporaryPath, outputPath);
    } catch (error) {
      await rm(temporaryPath, {force: true});
      throw error;
    }
  });
}

async function probeRecording(outputPath) {
  return globalLogger.timed('probeRecording', async () => {
    const result = await runCommand('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration:stream=index,codec_type,codec_name,channels,sample_rate,width,height',
      '-of', 'json',
      outputPath
    ], 'ffprobe.inspect');
    const data = JSON.parse(result.stdout);
    return {
      duration: Number.parseFloat(data.format?.duration || '0'),
      videoStreams: (data.streams || []).filter(stream => stream.codec_type === 'video'),
      audioStreams: (data.streams || []).filter(stream => stream.codec_type === 'audio')
    };
  });
}

async function measureAudioLevel(outputPath) {
  return globalLogger.timed('measureAudioLevel', async () => {
    const result = spawnSync('ffmpeg', [
      '-hide_banner',
      '-nostats',
      '-i', outputPath,
      '-map', '0:a:0',
      '-af', 'volumedetect',
      '-f', 'null',
      '-'
    ], {encoding: 'utf8'});
    if (result.error) throw result.error;
    const match = result.stderr.match(/mean_volume:\s*(-?inf|-?\d+(?:\.\d+)?)\s*dB/i);
    const meanVolumeDb = !match || match[1].toLowerCase() === '-inf'
      ? Number.NEGATIVE_INFINITY
      : Number.parseFloat(match[1]);
    await globalLogger.info('measureAudioLevel.result', {outputPath, meanVolumeDb});
    return meanVolumeDb;
  });
}

async function validateRecording(outputPath, expectedDuration, config) {
  return globalLogger.timed('validateRecording', async () => {
    await access(outputPath, fsConstants.R_OK);
    const fileStat = await stat(outputPath);
    if (fileStat.size < 100_000) throw new Error(`Recording is suspiciously small: ${fileStat.size} bytes`);

    const probe = await probeRecording(outputPath);
    if (!probe.videoStreams.length) throw new Error('Recording contains no video stream');
    if (config.capture.failWhenAudioStreamMissing && !probe.audioStreams.length) {
      throw new Error('Recording contains no audio stream');
    }

    const minimumExpectedDuration = Math.max(1, Number(expectedDuration || 0) * 0.9);
    if (probe.duration < minimumExpectedDuration) {
      throw new Error(
        `Recording is too short: ${probe.duration.toFixed(2)} seconds; expected at least ${minimumExpectedDuration.toFixed(2)}`
      );
    }

    let meanVolumeDb = null;
    if (probe.audioStreams.length) {
      meanVolumeDb = await measureAudioLevel(outputPath);
      if (meanVolumeDb <= config.capture.silentAudioThresholdDb) {
        const message = `Audio appears silent (${meanVolumeDb} dB mean)`;
        if (config.capture.failWhenAudioIsSilent) throw new Error(message);
        await globalLogger.warn('validateRecording.silentAudio', {outputPath, meanVolumeDb});
      }
    }

    return {...probe, sizeBytes: fileStat.size, meanVolumeDb};
  });
}

async function preserveFailedRaw(rawPath, config, job) {
  return globalLogger.timed('preserveFailedRaw', async () => {
    if (!rawPath || !existsSync(rawPath)) return null;
    const failedDirectory = path.join(config.paths.outputDirectory, '_failed_raw');
    await mkdir(failedDirectory, {recursive: true});
    const extension = path.extname(rawPath) || '.mkv';
    const destination = path.join(
      failedDirectory,
      `${String(job.index).padStart(3, '0')} - ${vimeoIdFromUrl(job.url)} - ${Date.now()}${extension}`
    );
    await copyFile(rawPath, destination);
    await globalLogger.warn('capture.raw.preserved', {rawPath, destination});
    return destination;
  });
}

async function stopRecordingSafely(obs) {
  return globalLogger.timed('stopRecordingSafely', async () => {
    const status = await obs.call('GetRecordStatus');
    if (!status.outputActive) return null;
    const result = await obs.call('StopRecord');
    await globalLogger.info('obs.recording.stopped', {outputPath: result.outputPath});
    return result.outputPath;
  });
}

async function captureJob(obs, server, config, job) {
  return globalLogger.timed('captureJob', async () => {
    const token = randomUUID();
    const channel = server.createChannel(token);
    let recordingStarted = false;
    let rawPath = null;

    try {
      const readyPromise = channel.waitFor('ready', config.capture.loadTimeoutMs);
      const controlPromise = channel.waitFor('controlConnected', config.capture.loadTimeoutMs);
      const errorPromise = channel.waitFor('error')
        .then(error => Promise.reject(new Error(`Vimeo player error: ${JSON.stringify(error)}`)));
      errorPromise.catch(() => {});

      const playerUrl = new URL('/player', server.baseUrl());
      playerUrl.searchParams.set('token', token);
      playerUrl.searchParams.set('url', job.url);
      playerUrl.searchParams.set('cacheBust', randomUUID());

      await obs.call('SetInputSettings', {
        inputName: config.obs.browserSourceName,
        inputSettings: {
          url: playerUrl.toString(),
          width: config.capture.width,
          height: config.capture.height,
          reroute_audio: true,
          shutdown: false,
          restart_when_active: true
        },
        overlay: true
      });
      await globalLogger.info('capture.player.loaded', {index: job.index, url: job.url});

      const [metadata] = await Promise.race([
        Promise.all([readyPromise, controlPromise]),
        errorPromise
      ]);
      await globalLogger.info('capture.player.ready', {index: job.index, metadata});

      await ensureNotRecording(obs);
      await obs.call('StartRecord');
      recordingStarted = true;
      await globalLogger.info('obs.recording.started', {index: job.index, url: job.url});
      await sleep(config.capture.preRollMs);

      const playingPromise = channel.waitFor('playing', config.capture.playTimeoutMs);
      await channel.sendCommand('play');
      await Promise.race([playingPromise, errorPromise]);

      const expectedDuration = Number(metadata.duration || 0);
      const completionTimeout = Math.max(
        config.capture.minimumCaptureTimeoutMs,
        expectedDuration * 1000 + config.capture.maximumExtraTimeMs
      );
      const endedPromise = channel.waitFor('ended', completionTimeout);
      const endedData = await Promise.race([endedPromise, errorPromise]);
      await globalLogger.info('capture.player.ended', {index: job.index, endedData});
      await sleep(config.capture.postRollMs);

      const stopped = await obs.call('StopRecord');
      recordingStarted = false;
      rawPath = stopped.outputPath;
      if (!rawPath) throw new Error('OBS stopped recording but did not return an output path');
      await globalLogger.info('obs.recording.stopped', {index: job.index, rawPath});

      const title = sanitizeFilename(metadata.title);
      const id = String(metadata.id || vimeoIdFromUrl(job.url));
      const outputName = `${String(job.index).padStart(3, '0')} - ${title} [${id}].mp4`;
      const outputPath = path.join(config.paths.outputDirectory, outputName);
      await remuxRecording(rawPath, outputPath);
      const validation = await validateRecording(outputPath, expectedDuration, config);

      if (config.capture.deleteRawAfterSuccess && path.resolve(rawPath) !== path.resolve(outputPath)) {
        await rm(rawPath, {force: true});
        await globalLogger.info('capture.raw.deleted', {rawPath});
      }

      return {
        index: job.index,
        url: job.url,
        title,
        id,
        expectedDuration,
        outputPath,
        outputName,
        capturedAt: new Date().toISOString(),
        validation
      };
    } catch (error) {
      if (recordingStarted) {
        try {
          rawPath = await stopRecordingSafely(obs);
        } catch (stopError) {
          await globalLogger.error('capture.emergencyStop.failed', {error: errorMessage(stopError)});
        }
      }
      await preserveFailedRaw(rawPath, config, job);
      throw error;
    } finally {
      server.removeChannel(token);
      try {
        await obs.call('SetInputSettings', {
          inputName: config.obs.browserSourceName,
          inputSettings: {url: `${server.baseUrl()}/health`},
          overlay: true
        });
      } catch (error) {
        await globalLogger.warn('capture.browserReset.failed', {error: errorMessage(error)});
      }
    }
  });
}

async function writeFailureFile(state, failurePath) {
  return globalLogger.timed('writeFailureFile', async () => {
    const failures = Object.values(state.failures).sort((a, b) => a.index - b.index);
    await writeFile(failurePath, `${JSON.stringify(failures, null, 2)}\n`, 'utf8');
  });
}

async function writePlaylist(state, playlistPath) {
  return globalLogger.timed('writePlaylist', async () => {
    const captures = Object.values(state.completed)
      .filter(item => existsSync(item.outputPath))
      .sort((a, b) => a.index - b.index);
    const lines = ['#EXTM3U'];
    for (const capture of captures) {
      const duration = Math.round(capture.validation?.duration || capture.expectedDuration || -1);
      lines.push(`#EXTINF:${duration},${capture.title}`);
      lines.push(capture.outputPath);
    }
    await writeFile(playlistPath, `${lines.join('\n')}\n`, 'utf8');
    await globalLogger.info('playlist.written', {playlistPath, entries: captures.length});
  });
}

async function runDoctor(obs, config, server) {
  return globalLogger.timed('runDoctor', async () => {
    if (!commandExists('ffmpeg')) throw new Error('ffmpeg is not installed or not in PATH');
    if (!commandExists('ffprobe')) throw new Error('ffprobe is not installed or not in PATH');
    await access(config.paths.input, fsConstants.R_OK);
    await ensureNotRecording(obs);
    const settings = await obs.call('GetInputSettings', {inputName: config.obs.browserSourceName});
    const version = await obs.call('GetVersion');
    await globalLogger.info('doctor.success', {
      obsVersion: version.obsVersion,
      obsWebSocketVersion: version.obsWebSocketVersion,
      browserInputKind: settings.inputKind,
      browserAudioRerouted: settings.inputSettings?.reroute_audio,
      localPlayerUrl: `${server.baseUrl()}/player`,
      inputFile: config.paths.input
    });
  });
}

let globalLogger;
let activeObs;
let activeServer;
let previousSceneName;
let shutdownStarted = false;

async function cleanup() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  const started = performance.now();
  await globalLogger?.info('cleanup.start');
  if (activeObs) {
    try {
      await stopRecordingSafely(activeObs);
    } catch (error) {
      await globalLogger?.warn('cleanup.stopRecording.failed', {error: errorMessage(error)});
    }
    if (previousSceneName) {
      try {
        await activeObs.call('SetCurrentProgramScene', {sceneName: previousSceneName});
      } catch (error) {
        await globalLogger?.warn('cleanup.restoreScene.failed', {error: errorMessage(error)});
      }
    }
    try {
      await activeObs.disconnect();
    } catch (error) {
      await globalLogger?.warn('cleanup.obsDisconnect.failed', {error: errorMessage(error)});
    }
  }
  if (activeServer) await activeServer.stop();
  globalLogger?.recordTiming('cleanup', started);
  await globalLogger?.writeMetaTimeRunLog();
}

async function main() {
  const bootStarted = performance.now();
  const preliminaryConfigPath = path.join(SCRIPT_DIRECTORY, 'config.json');
  const preliminaryConfig = existsSync(preliminaryConfigPath)
    ? JSON.parse(await readFile(preliminaryConfigPath, 'utf8'))
    : JSON.parse(await readFile(path.join(SCRIPT_DIRECTORY, 'config.example.json'), 'utf8'));
  globalLogger = new Logger(resolveConfiguredPath(preliminaryConfig.files.logDirectory));
  await globalLogger.initialize();
  await globalLogger.info('application.start', {
    version: '1.0.0',
    doctorMode: DOCTOR_MODE,
    jobLimit: Number.isFinite(JOB_LIMIT) ? JOB_LIMIT : null
  });

  const config = await loadConfig();
  await mkdir(config.paths.outputDirectory, {recursive: true});
  if (!commandExists('ffmpeg') || !commandExists('ffprobe')) {
    throw new Error('ffmpeg/ffprobe are required. Install them with: brew install ffmpeg');
  }

  await launchObsIfRequested(config);
  activeServer = new CaptureServer(config, globalLogger);
  await activeServer.start();
  activeObs = new OBSWebSocket();
  await connectObs(config, activeObs);
  const sceneState = await ensureObsSceneAndSource(activeObs, config, activeServer);
  previousSceneName = sceneState.previousSceneName === config.obs.sceneName
    ? null
    : sceneState.previousSceneName;

  if (DOCTOR_MODE) {
    await runDoctor(activeObs, config, activeServer);
    await globalLogger.info('application.doctor.complete');
    globalLogger.recordTiming('application.total', bootStarted);
    return;
  }

  const jobs = await loadJobs(config.paths.input);
  const state = await loadState(config.paths.state);
  let attempted = 0;

  for (const job of jobs) {
    if (attempted >= JOB_LIMIT) break;
    if (state.completed[job.url]?.outputPath && existsSync(state.completed[job.url].outputPath)) {
      await globalLogger.info('capture.skipped.complete', {index: job.index, url: job.url});
      continue;
    }

    attempted += 1;
    let completed = false;
    for (let attempt = 1; attempt <= config.capture.maxAttempts; attempt += 1) {
      await globalLogger.info('capture.attempt.start', {
        index: job.index,
        url: job.url,
        attempt,
        maxAttempts: config.capture.maxAttempts
      });
      try {
        const result = await captureJob(activeObs, activeServer, config, job);
        state.completed[job.url] = result;
        delete state.failures[job.url];
        await saveState(config.paths.state, state);
        await writePlaylist(state, config.paths.playlist);
        await globalLogger.info('capture.success', {
          index: job.index,
          url: job.url,
          outputPath: result.outputPath
        });
        completed = true;
        break;
      } catch (error) {
        state.failures[job.url] = {
          index: job.index,
          url: job.url,
          attempt,
          error: errorMessage(error),
          failedAt: new Date().toISOString()
        };
        await saveState(config.paths.state, state);
        await writeFailureFile(state, config.paths.failures);
        await globalLogger.error('capture.attempt.failed', {
          index: job.index,
          url: job.url,
          attempt,
          error: errorMessage(error)
        });
        if (attempt < config.capture.maxAttempts) {
          await globalLogger.info('capture.retry.wait', {milliseconds: config.capture.retryDelayMs});
          await sleep(config.capture.retryDelayMs);
        }
      }
    }

    if (!completed) {
      await globalLogger.error('capture.exhausted', {index: job.index, url: job.url});
    }
  }

  await writePlaylist(state, config.paths.playlist);
  await writeFailureFile(state, config.paths.failures);
  globalLogger.recordTiming('application.total', bootStarted);
  await globalLogger.info('application.complete', {
    totalUrls: jobs.length,
    attempted,
    completed: Object.keys(state.completed).length,
    failed: Object.keys(state.failures).length,
    playlist: config.paths.playlist
  });
}

process.on('SIGINT', async () => {
  await globalLogger?.warn('application.signal', {signal: 'SIGINT'});
  await cleanup();
  process.exit(130);
});

process.on('SIGTERM', async () => {
  await globalLogger?.warn('application.signal', {signal: 'SIGTERM'});
  await cleanup();
  process.exit(143);
});

try {
  await main();
} catch (error) {
  await globalLogger?.error('application.failed', {error: errorMessage(error)});
  process.exitCode = 1;
} finally {
  await cleanup();
}
