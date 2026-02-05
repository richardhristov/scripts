#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-net

import * as path from "jsr:@std/path@1.1.1";
import { parseArgs } from "jsr:@std/cli@1.0.21/parse-args";
import { Cron } from "npm:croner@8.0.0";

interface JobConfig {
  command: string;
  args: string[];
  cwd?: string;
  schedule: string;
}

interface JobRun {
  id: string;
  jobIndex: number;
  startTime: Date;
  endTime?: Date;
  status: "running" | "completed" | "failed";
  output: string;
  exitCode?: number;
  error?: string;
}

interface SchedulerConfig {
  jobs: JobConfig[];
  webPort?: number;
}

const MAX_RUNS_PER_JOB = 50;

class JobScheduler {
  private jobs = new Map<number, Cron>();
  private runningJobs = new Map<number, JobRun>();
  /** Per-job run history (newest first). */
  private jobRunsByJob = new Map<number, JobRun[]>();
  private config: SchedulerConfig;
  private configPath: string;

  constructor(configPath: string) {
    this.configPath = configPath;
    this.config = {
      jobs: [],
      webPort: 8080,
    };
  }

  async loadConfig() {
    try {
      const configText = await Deno.readTextFile(this.configPath);
      this.config = { ...this.config, ...JSON.parse(configText) };
      console.log(`Loaded config from ${this.configPath}`);
      console.log(`Found ${this.config.jobs.length} jobs`);
    } catch (e) {
      console.error(`Error loading config: ${e}`);
      Deno.exit(1);
    }
  }

  async start() {
    await this.loadConfig();
    this.setupJobs();
    this.startWebServer();

    console.log(`Cron scheduler started on port ${this.config.webPort}`);
    console.log(`Web interface: http://localhost:${this.config.webPort}`);

    // Keep the process running
    await new Promise(() => {});
  }

  private setupJobs() {
    for (const [index, jobConfig] of this.config.jobs.entries()) {
      const job = new Cron(
        jobConfig.schedule,
        async () => {
          await this.runJob(jobConfig);
        },
        {
          timezone: "UTC",
        }
      );

      this.jobs.set(index, job);
      console.log(
        `Scheduled job #${index}: ${jobConfig.command} ${jobConfig.args.join(
          " "
        )} (${jobConfig.schedule})`
      );
    }
  }

  private async runJob(jobConfig: JobConfig) {
    const index = this.config.jobs.indexOf(jobConfig);
    if (index === -1) return;
    // Check if job is already running
    if (this.runningJobs.has(index)) {
      console.log(`Job #${index} is already running, skipping`);
      return;
    }

    const runId = `${index}-${Date.now()}`;
    const jobRun: JobRun = {
      id: runId,
      jobIndex: index,
      startTime: new Date(),
      status: "running",
      output: "",
    };

    this.runningJobs.set(index, jobRun);
    console.log(
      `Starting job #${index}: ${jobConfig.command} ${jobConfig.args.join(" ")}`
    );

    try {
      const result = await this.executeCommand(jobConfig, jobRun);
      jobRun.status = result.success ? "completed" : "failed";
      jobRun.exitCode = result.exitCode;
      jobRun.error = result.error;
      jobRun.endTime = new Date();

      console.log(`Job #${index} ${result.success ? "completed" : "failed"}`);
    } catch (e) {
      jobRun.status = "failed";
      jobRun.error = e instanceof Error ? e.message : String(e);
      jobRun.endTime = new Date();
      console.error(`Job #${index} failed:`, e);
    } finally {
      this.runningJobs.delete(index);
      const runs = this.jobRunsByJob.get(index) ?? [];
      runs.unshift(jobRun);
      this.jobRunsByJob.set(index, runs.slice(0, MAX_RUNS_PER_JOB));
    }
  }

  private async executeCommand(
    jobConfig: JobConfig,
    jobRun: JobRun
  ): Promise<{ success: boolean; exitCode?: number; error?: string }> {
    // Default to the directory where the cron scheduler script is located
    const defaultCwd = path.dirname(path.fromFileUrl(import.meta.url));
    const workingDir = jobConfig.cwd || defaultCwd;

    const cmd = new Deno.Command(jobConfig.command, {
      args: jobConfig.args,
      cwd: workingDir,
      stdout: "piped",
      stderr: "piped",
    });

    const process = cmd.spawn();

    // Handle stdout
    let stdoutPromise: Promise<void> | undefined;
    const stdoutReader = process.stdout?.getReader();
    if (stdoutReader) {
      const decoder = new TextDecoder();
      stdoutPromise = (async () => {
        try {
          while (true) {
            const { done, value } = await stdoutReader.read();
            if (done) break;

            const text = decoder.decode(value, { stream: true });
            jobRun.output += text;
          }
        } catch (_e) {
          // Ignore errors when process ends
        }
      })();
    }

    // Handle stderr
    let stderrPromise: Promise<void> | undefined;
    const stderrReader = process.stderr?.getReader();
    if (stderrReader) {
      const decoder = new TextDecoder();
      stderrPromise = (async () => {
        try {
          while (true) {
            const { done, value } = await stderrReader.read();
            if (done) break;

            const text = decoder.decode(value, { stream: true });
            jobRun.output += text;
          }
        } catch (_e) {
          // Ignore errors when process ends
        }
      })();
    }

    const status = await process.status;

    await Promise.all([stdoutPromise, stderrPromise].filter(Boolean));

    return {
      success: status.success,
      exitCode: status.code,
      error: status.success
        ? undefined
        : `Process exited with code ${status.code}`,
    };
  }

  private startWebServer() {
    const port = this.config.webPort || 8080;

    Deno.serve({
      port,
      handler: (req: Request) => {
        const url = new URL(req.url);

        if (url.pathname === "/") {
          return this.renderDashboard();
        } else if (url.pathname === "/api/jobs") {
          return this.handleJobsApi();
        } else if (url.pathname === "/api/job") {
          return this.handleJobApi(url);
        } else if (url.pathname === "/api/run") {
          return this.handleRunJob(url);
        }

        return new Response("Not found", { status: 404 });
      },
    });
  }

  private renderDashboard(): Response {
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <title>Cron Scheduler</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css">
    <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
    <style>
        :root {
            --bg: #0c0c0f;
            --bg-card: #141417;
            --bg-elevated: #1a1a1e;
            --border: #2a2a2e;
            --text: #e4e4e7;
            --text-muted: #71717a;
            --accent: #a1a1aa;
            --accent-soft: rgba(255,255,255,0.06);
            --success: #22c55e;
            --success-soft: rgba(34, 197, 94, 0.15);
            --danger: #ef4444;
            --danger-soft: rgba(239, 68, 68, 0.15);
            --live: #10b981;
            --live-soft: rgba(16, 185, 129, 0.15);
        }
        * { box-sizing: border-box; }
        body { font-family: 'SF Mono', 'Fira Code', ui-monospace, monospace; margin: 0; padding: 0; background: var(--bg); color: var(--text); min-height: 100vh; -webkit-font-smoothing: antialiased; }
        .container { max-width: 1280px; margin: 0 auto; padding: 28px; }
        .header { margin-bottom: 32px; padding-bottom: 24px; border-bottom: 1px solid var(--border); }
        .header h1 { font-size: 1.375rem; font-weight: 600; margin: 0 0 4px 0; letter-spacing: -0.02em; color: var(--text); }
        .header p { margin: 0; font-size: 0.8125rem; color: var(--text-muted); }
        .jobs-grid { display: flex; flex-direction: column; gap: 20px; }
        .job-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
        .job-card-header { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; padding: 18px 20px; border-bottom: 1px solid var(--border); }
        .job-name { font-size: 0.9rem; font-weight: 500; color: var(--text); word-break: break-all; }
        .job-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
        .job-schedule { font-size: 0.7rem; color: var(--text-muted); padding: 5px 9px; background: var(--bg); border-radius: 6px; border: 1px solid var(--border); }
        .job-next-run { font-size: 0.7rem; color: var(--text-muted); }
        .job-status { padding: 5px 10px; border-radius: 6px; font-size: 0.7rem; font-weight: 500; text-transform: uppercase; letter-spacing: 0.03em; }
        .job-runtime { font-size: 0.75rem; color: var(--text-muted); margin-left: 8px; }
        .status-running { background: var(--live-soft); color: var(--live); }
        .status-completed { background: var(--success-soft); color: var(--success); }
        .status-failed { background: var(--danger-soft); color: var(--danger); }
        .status-idle { background: var(--bg-elevated); color: var(--text-muted); }
        .job-actions { display: flex; gap: 8px; }
        .btn { padding: 8px 14px; border-radius: 6px; cursor: pointer; font-size: 0.8rem; font-family: inherit; transition: background 0.2s ease, color 0.2s ease, border-color 0.2s ease; border: 1px solid var(--border); background: var(--bg-card); color: var(--text); }
        .btn:hover { background: var(--bg-elevated); color: var(--text); border-color: var(--text-muted); }
        .btn:active { transform: translateY(0); }
        .btn-primary { background: var(--bg-elevated); color: var(--text); border-color: var(--border); }
        .btn-primary:hover:not(:disabled) { background: var(--border); color: var(--text); }
        .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
        .runs-section { padding: 14px 20px; border-bottom: 1px solid var(--border); background: var(--bg); }
        .runs-label { font-size: 0.65rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 10px; }
        .runs-list { display: flex; flex-wrap: wrap; gap: 6px; }
        .run-pill { padding: 6px 11px; border-radius: 6px; font-size: 0.75rem; cursor: pointer; border: 1px solid transparent; background: var(--bg-card); color: var(--text-muted); transition: background 0.2s ease, color 0.2s ease, border-color 0.2s ease; }
        .run-pill:hover { background: var(--bg-elevated); color: var(--text); border-color: var(--border); }
        .run-pill.active { background: var(--accent-soft); color: var(--text); border-color: var(--border); }
        .run-pill .run-status-dot { width: 5px; height: 5px; border-radius: 50%; display: inline-block; margin-right: 6px; vertical-align: middle; }
        .run-pill .run-status-dot.completed { background: var(--success); }
        .run-pill .run-status-dot.failed { background: var(--danger); }
        .run-pill .run-status-dot.running { background: var(--live); }
        .terminal-wrap { padding: 18px 20px 20px; }
        .terminal-container { border-radius: 8px; overflow: hidden; background: #08080a; border: 1px solid var(--border); min-height: 200px; }
        .terminal-container .xterm { padding: 12px; }
        .terminal-container .xterm-cursor { display: none !important; }
        .terminal-container .xterm-cursor-block { display: none !important; }
        .toast-container { position: fixed; bottom: 24px; right: 24px; z-index: 1000; display: flex; flex-direction: column; gap: 8px; max-width: 360px; pointer-events: none; }
        .toast-container > * { pointer-events: auto; }
        .toast { padding: 12px 16px; border-radius: 8px; font-size: 0.8125rem; background: var(--bg-elevated); border: 1px solid var(--border); box-shadow: 0 8px 24px rgba(0,0,0,0.4); display: flex; align-items: flex-start; gap: 10px; animation: toast-in 0.2s ease; }
        .toast-error { border-color: var(--danger); background: var(--danger-soft); color: var(--text); }
        .toast-msg { flex: 1; word-break: break-word; }
        .toast-dismiss { flex-shrink: 0; padding: 2px; cursor: pointer; background: none; border: none; color: var(--text-muted); font-size: 1rem; line-height: 1; border-radius: 4px; }
        .toast-dismiss:hover { color: var(--text); background: var(--accent-soft); }
        @keyframes toast-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    </style>
</head>
<body>
    <div class="toast-container" id="toastContainer" aria-live="polite"></div>
    <div class="container">
        <div class="header">
            <h1>Cron Scheduler</h1>
            <p>Jobs and run history — click a run to view its log</p>
        </div>
        <div class="jobs-grid" id="jobsGrid"></div>
    </div>

    <script>
        const terminals = {};
        const selectedRunByJob = {}; // jobId -> runId or null for "current"

        function formatRunTime(iso) {
            if (!iso) return '—';
            const d = new Date(iso);
            const now = new Date();
            const sameDay = d.toDateString() === now.toDateString();
            return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
        }

        function formatDuration(ms) {
            if (ms == null || ms < 0) return '0:00';
            const sec = Math.floor(ms / 1000);
            const m = Math.floor(sec / 60) % 60;
            const s = sec % 60;
            const h = Math.floor(sec / 3600);
            const pad = n => String(n).padStart(2, '0');
            if (h > 0) return h + ':' + pad(m) + ':' + pad(s);
            return Math.floor(sec / 60) + ':' + pad(s);
        }

        function elapsedSince(iso) {
            if (!iso) return null;
            return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
        }

        function formatNextRun(iso) {
            if (!iso) return '—';
            const d = new Date(iso);
            const ms = d.getTime() - Date.now();
            if (ms <= 0) return 'soon';
            const sec = Math.floor(ms / 1000);
            if (sec < 60) return 'in <1m';
            const min = Math.floor(sec / 60);
            if (min < 60) return 'in ' + min + 'm';
            const h = Math.floor(min / 60);
            const now = new Date();
            if (h < 24 && now.toDateString() === d.toDateString()) return 'at ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            return 'at ' + d.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
        }

        function showToast(message, type) {
            type = type || 'error';
            const container = document.getElementById('toastContainer');
            const el = document.createElement('div');
            el.className = 'toast toast-' + type;
            el.setAttribute('role', 'alert');
            el.innerHTML = '<span class="toast-msg">' + escapeHtml(message) + '</span><button type="button" class="toast-dismiss" aria-label="Dismiss">×</button>';
            const dismiss = () => { el.style.animation = 'toast-in 0.15s ease reverse'; setTimeout(() => el.remove(), 150); };
            el.querySelector('.toast-dismiss').addEventListener('click', dismiss);
            container.appendChild(el);
            setTimeout(dismiss, 5000);
        }

        function initTerminal(jobId) {
            if (terminals[jobId]) { terminals[jobId].term.dispose(); }
            const container = document.getElementById('terminal-' + jobId);
            if (!container) return;
            const fitAddon = new window.FitAddon.FitAddon();
            const term = new window.Terminal({
                convertEol: true, disableStdin: true, cursorBlink: false, cursorStyle: 'block',
                rows: 60, allowTransparency: true, scrollback: 1000,
                theme: { background: '#0a0c10', foreground: '#e6edf3', cursor: '#e6edf3', cursorAccent: '#0a0c10' }
            });
            term.loadAddon(fitAddon);
            term.onData(() => {}); term.onKey(() => {}); term.onSelectionChange(() => {});
            term.open(container);
            setTimeout(() => {
                term.clear();
                const proposed = fitAddon.proposeDimensions();
                if (proposed) term.resize(proposed.cols, 60);
            }, 100);
            terminals[jobId] = { term, fitAddon, outputLength: 0, lastStartTime: null, selectedRunId: null };
        }

        function updateJobCard(job) {
            const jobsGrid = document.getElementById('jobsGrid');
            let jobCard = document.getElementById('job-card-' + job.id);
            if (!jobCard) {
                jobCard = document.createElement('div');
                jobCard.className = 'job-card';
                jobCard.id = 'job-card-' + job.id;
                jobCard.innerHTML = \`
                    <div class="job-card-header">
                        <div class="job-name">\${escapeHtml(job.command)} \${job.args.map(escapeHtml).join(' ')}</div>
                        <div class="job-meta">
                            <span class="job-schedule">\${escapeHtml(job.schedule)}</span>
                            <span class="job-next-run"></span>
                            <div class="job-status"></div>
                            <span class="job-runtime"></span>
                            <div class="job-actions">
                                <button class="btn btn-primary" data-job-id="\${job.id}">Run now</button>
                            </div>
                        </div>
                    </div>
                    <div class="runs-section">
                        <div class="runs-label">Runs</div>
                        <div class="runs-list" data-job-id="\${job.id}"></div>
                    </div>
                    <div class="terminal-wrap">
                        <div class="terminal-container" id="terminal-\${job.id}"></div>
                    </div>
                \`;
                jobsGrid.appendChild(jobCard);
                initTerminal(job.id);
                jobCard.querySelector('.btn-primary').addEventListener('click', () => runJob(String(job.id)));
                jobCard.querySelector('.runs-list').addEventListener('click', (e) => {
                    const pill = e.target.closest('.run-pill');
                    if (pill && pill.dataset.runId !== undefined) selectRun(String(job.id), pill.dataset.runId || null);
                });
            }

            const statusEl = jobCard.querySelector('.job-status');
            const statusClass = 'status-' + (job.status || 'idle');
            statusEl.className = 'job-status ' + statusClass;
            statusEl.textContent = job.status || 'idle';

            const nextRunEl = jobCard.querySelector('.job-next-run');
            if (nextRunEl) {
                if (job.nextRunTime) {
                    jobCard.dataset.nextRunTime = job.nextRunTime;
                    nextRunEl.textContent = 'Next: ' + formatNextRun(job.nextRunTime);
                    nextRunEl.style.display = '';
                } else {
                    delete jobCard.dataset.nextRunTime;
                    nextRunEl.textContent = '';
                    nextRunEl.style.display = 'none';
                }
            }

            const runtimeEl = jobCard.querySelector('.job-runtime');
            if (job.status === 'running' && job.runStartTime) {
                jobCard.dataset.runStartTime = job.runStartTime;
                const sec = elapsedSince(job.runStartTime);
                runtimeEl.textContent = sec != null ? formatDuration(sec * 1000) : '';
                runtimeEl.style.display = '';
            } else {
                delete jobCard.dataset.runStartTime;
                runtimeEl.textContent = '';
                runtimeEl.style.display = 'none';
            }

            const runsList = jobCard.querySelector('.runs-list');
            runsList.innerHTML = '';
            const selectedRunId = selectedRunByJob[job.id];
            const runs = job.runs || [];
            const addPill = (label, runId, status) => {
                const pill = document.createElement('span');
                pill.className = 'run-pill' + (selectedRunId === runId || (!runId && !selectedRunId) ? ' active' : '');
                pill.dataset.runId = runId || '';
                const dot = status ? \`<span class="run-status-dot \${status}"></span>\` : '';
                pill.innerHTML = dot + label;
                runsList.appendChild(pill);
            };
            const liveLabel = job.status === 'running' && job.runStartTime
                ? 'Live · ' + formatDuration((elapsedSince(job.runStartTime) || 0) * 1000)
                : (job.status === 'running' ? 'Live' : 'Latest');
            addPill(liveLabel, null, job.status === 'running' ? 'running' : null);
            runs.forEach((r, i) => {
                const timePart = formatRunTime(r.startTime);
                const durationPart = r.durationMs != null ? ' · ' + formatDuration(r.durationMs) : '';
                const exitPart = r.exitCode !== undefined && r.exitCode !== 0 ? ' (exit ' + r.exitCode + ')' : '';
                const label = timePart + durationPart + exitPart;
                addPill(label, r.id, r.status);
            });
        }

        function escapeHtml(s) {
            const div = document.createElement('div');
            div.textContent = s;
            return div.innerHTML;
        }

        function selectRun(jobId, runId) {
            selectedRunByJob[jobId] = runId || null;
            const t = terminals[jobId];
            if (t) {
                t.outputLength = 0;
                t.lastStartTime = null;
                t.selectedRunId = runId;
                t.term.clear();
            }
            const card = document.getElementById('job-card-' + jobId);
            if (card) {
                card.querySelectorAll('.run-pill').forEach(p => {
                    p.classList.toggle('active', (p.dataset.runId || null) === (runId || null));
                });
            }
            if (runId) fetchRunOutput(jobId, runId, true);
            else updateJobOutput(jobId);
        }

        async function fetchRunOutput(jobId, runId, full) {
            const t = terminals[jobId];
            if (!t) return;
            const url = '/api/job?name=' + encodeURIComponent(jobId) + '&runId=' + encodeURIComponent(runId) + (full ? '&since=0' : '&since=' + t.outputLength);
            const res = await fetch(url);
            const data = await res.json();
            if (data.output) {
                t.term.write(data.output);
                t.outputLength = data.outputLength;
            }
        }

        async function updateDashboard() {
            try {
                const res = await fetch('/api/jobs');
                const data = await res.json();
                data.jobs.forEach(job => updateJobCard(job));
            } catch (e) { console.error('Error updating dashboard:', e); }
        }

        function runJob(jobId) {
            const btn = document.querySelector('.btn-primary[data-job-id="' + jobId + '"]');
            if (btn) { btn.disabled = true; btn.textContent = 'Running…'; }
            fetch('/api/run?job=' + encodeURIComponent(jobId), { method: 'POST' })
                .then(r => r.json())
                .then(data => {
                    if (btn) { btn.disabled = false; btn.textContent = 'Run now'; }
                    if (data.success) {
                        selectRun(jobId, null);
                        if (terminals[jobId]) {
                            terminals[jobId].term.clear();
                            terminals[jobId].outputLength = 0;
                            terminals[jobId].lastStartTime = null;
                        }
                        updateDashboard();
                    } else {
                        showToast(data.error || 'Run failed', 'error');
                    }
                })
                .catch(e => { if (btn) { btn.disabled = false; btn.textContent = 'Run now'; showToast('Network error', 'error'); } console.error(e); });
        }

        function updateJobOutput(jobId) {
            const t = terminals[jobId];
            if (!t) return;
            if (selectedRunByJob[jobId]) return; // viewing a specific run, no live tail
            const since = t.outputLength;
            const url = '/api/job?name=' + encodeURIComponent(jobId) + '&since=' + since;
            fetch(url).then(r => r.json()).then(data => {
                if (data.logReset) { t.term.clear(); t.outputLength = 0; }
                if (data.startTime && t.lastStartTime !== data.startTime.toString()) {
                    t.term.clear();
                    t.outputLength = 0;
                    t.lastStartTime = data.startTime.toString();
                    fetch('/api/job?name=' + encodeURIComponent(jobId) + '&since=0').then(r2 => r2.json()).then(d2 => {
                        if (d2.output) { t.term.write(d2.output); t.outputLength = d2.outputLength; }
                    });
                    return;
                }
                if (data.output) { t.term.write(data.output); t.outputLength = data.outputLength; }
            }).catch(() => {});
        }

        function tickRunningRuntimes() {
            document.querySelectorAll('.job-card[data-run-start-time]').forEach(card => {
                const runtimeEl = card.querySelector('.job-runtime');
                const startIso = card.dataset.runStartTime;
                if (runtimeEl && startIso) {
                    const sec = elapsedSince(startIso);
                    runtimeEl.textContent = sec != null ? formatDuration(sec * 1000) : '';
                }
                const livePill = card.querySelector('.run-pill[data-run-id=""]');
                if (livePill && startIso) {
                    const sec = elapsedSince(startIso);
                    const dot = '<span class="run-status-dot running"></span>';
                    livePill.innerHTML = dot + 'Live · ' + formatDuration((sec || 0) * 1000);
                }
            });
            document.querySelectorAll('.job-card[data-next-run-time]').forEach(card => {
                const nextRunEl = card.querySelector('.job-next-run');
                const iso = card.dataset.nextRunTime;
                if (nextRunEl && iso) nextRunEl.textContent = 'Next: ' + formatNextRun(iso);
            });
        }

        updateDashboard();
        setInterval(updateDashboard, 2000);
        setInterval(tickRunningRuntimes, 1000);
        setInterval(() => {
            Object.keys(terminals).forEach(jobId => {
                if (selectedRunByJob[jobId] != null) return;
                updateJobOutput(jobId);
            });
        }, 1000);
        window.addEventListener('resize', () => {
            Object.values(terminals).forEach(t => {
                const p = t.fitAddon.proposeDimensions();
                if (p) t.term.resize(p.cols, 60);
            });
        });
    </script>
</body>
</html>`;

    return new Response(html, {
      headers: { "Content-Type": "text/html" },
    });
  }

  private handleJobsApi(): Response {
    const jobs = this.config.jobs.map((job, index) => {
      const cron = this.jobs.get(index);
      const runningJob = this.runningJobs.get(index);
      const runs = this.jobRunsByJob.get(index) ?? [];
      const latestRun = runs[0];
      const nextRun =
        typeof (cron as { nextRun?: () => Date })?.nextRun === "function"
          ? (cron as { nextRun: () => Date }).nextRun()
          : undefined;

      let status = "idle";
      if (runningJob) {
        status = "running";
      } else if (latestRun) {
        status = latestRun.status;
      }

      return {
        id: index,
        command: job.command,
        args: job.args,
        schedule: job.schedule,
        status: status,
        runStartTime: runningJob?.startTime ?? undefined,
        nextRunTime: nextRun ?? undefined,
        runs: runs.map((r) => {
          const durationMs =
            r.endTime != null
              ? r.endTime.getTime() - r.startTime.getTime()
              : undefined;
          return {
            id: r.id,
            startTime: r.startTime,
            endTime: r.endTime,
            status: r.status,
            exitCode: r.exitCode,
            durationMs: durationMs ?? undefined,
          };
        }),
      };
    });

    return new Response(JSON.stringify({ jobs }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private handleJobApi(url: URL): Response {
    const jobIdStr = url.searchParams.get("name");
    if (!jobIdStr) {
      return new Response(JSON.stringify({ error: "Job ID required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const jobIndex = parseInt(jobIdStr, 10);
    if (isNaN(jobIndex)) {
      return new Response(JSON.stringify({ error: "Invalid job ID" }), {
        status: 400,
      });
    }
    if (jobIndex < 0 || jobIndex >= this.config.jobs.length) {
      return new Response(JSON.stringify({ error: "Invalid job ID" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const since = parseInt(url.searchParams.get("since") || "0", 10);
    const runIdParam = url.searchParams.get("runId");

    let run: JobRun | undefined;
    if (runIdParam) {
      const runs = this.jobRunsByJob.get(jobIndex) ?? [];
      run = runs.find((r) => r.id === runIdParam);
    }
    if (!run) {
      run =
        this.runningJobs.get(jobIndex) ||
        (this.jobRunsByJob.get(jobIndex) ?? [])[0];
    }

    if (run) {
      const fullOutput = run.output || "";
      let partialOutput = "";
      let logReset = false;

      if (since > 0 && since > fullOutput.length) {
        partialOutput = fullOutput;
        logReset = true;
      } else {
        partialOutput = fullOutput.substring(since);
      }

      return new Response(
        JSON.stringify({
          id: run.jobIndex,
          runId: run.id,
          status: run.status,
          startTime: run.startTime,
          endTime: run.endTime,
          output: partialOutput,
          outputLength: fullOutput.length,
          logReset: logReset,
          exitCode: run.exitCode,
          error: run.error,
        }),
        {
          headers: { "Content-Type": "application/json" },
        }
      );
    } else {
      return new Response(JSON.stringify({ error: "Job not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  private handleRunJob(url: URL): Response {
    const jobIdStr = url.searchParams.get("job");
    if (!jobIdStr) {
      return new Response(JSON.stringify({ error: "Job ID required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const jobIndex = parseInt(jobIdStr, 10);
    if (
      isNaN(jobIndex) ||
      jobIndex < 0 ||
      jobIndex >= this.config.jobs.length
    ) {
      return new Response(JSON.stringify({ error: "Invalid job ID" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const jobConfig = this.config.jobs[jobIndex];
    if (!jobConfig) {
      return new Response(JSON.stringify({ error: "Job not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Check if already running
    if (this.runningJobs.has(jobIndex)) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Job is already running",
        }),
        {
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Run the job asynchronously
    this.runJob(jobConfig);

    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }
}

async function main() {
  const flags = parseArgs(Deno.args, {
    string: ["config"],
    alias: { c: "config" },
    default: { config: "cron.conf.json" },
  });

  const configPath = flags.config as string;

  if (!configPath) {
    console.error("Usage: cron.ts --config <config-file>");
    console.error("Example: cron.ts --config cron.conf.json");
    Deno.exit(1);
  }

  try {
    const scheduler = new JobScheduler(configPath);
    await scheduler.start();
  } catch (e) {
    console.error("Error starting scheduler:", e);
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main();
}
