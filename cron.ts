#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-net

import * as path from "jsr:@std/path";
import { parseArgs } from "jsr:@std/cli/parse-args";
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

class JobScheduler {
  private jobs = new Map<number, Cron>();
  private runningJobs = new Map<number, JobRun>();
  private completedJobs: JobRun[] = [];
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
      this.completedJobs.unshift(jobRun);

      // Keep only recent jobs
      const maxJobs = 100;
      if (this.completedJobs.length > maxJobs) {
        this.completedJobs = this.completedJobs.slice(0, maxJobs);
      }
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
<html>
<head>
    <title>Cron Scheduler Dashboard</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css">
    <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js"></script>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
        .container { max-width: 1200px; margin: 0 auto; }
        .header { background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .jobs-grid { display: flex; flex-direction: column; gap: 20px; }
        .job-card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .job-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
        .job-name { font-weight: bold; font-size: 16px; }
        .job-status { padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; }
        .status-running { background: #e3f2fd; color: #1976d2; }
        .status-completed { background: #e8f5e8; color: #2e7d32; }
        .status-failed { background: #ffebee; color: #c62828; }
        .job-schedule { font-size: 12px; color: #666; margin-bottom: 10px; }
        .job-description { font-size: 14px; color: #333; margin-bottom: 15px; }
        .job-actions { display: flex; gap: 10px; margin-bottom: 15px; }
        .btn { padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; }
        .btn-primary { background: #1976d2; color: white; }
        .terminal-container { border-radius: 4px; padding: 10px; background: #1e1e1e; }
        .terminal-container .xterm-cursor { display: none !important; }
        .terminal-container .xterm-cursor-block { display: none !important; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Cron Scheduler Dashboard</h1>
            <p>Monitor and manage your scheduled jobs</p>
        </div>
        
        <div class="jobs-grid" id="jobsGrid">
            <!-- Jobs will be populated here -->
        </div>
    </div>

    <script>
        const terminals = {};

        function initTerminal(jobId) {
            if (terminals[jobId]) {
                terminals[jobId].dispose();
            }
            const container = document.getElementById('terminal-' + jobId);
            if (!container) return;

            const term = new window.Terminal({
                convertEol: true,
                disableStdin: true,
                cursorBlink: false,
                cursorStyle: 'block',
                rows: 15,
                allowTransparency: true,
                scrollback: 1000,
                theme: {
                    background: '#1e1e1e',
                    foreground: '#ffffff',
                    cursor: '#ffffff',
                    cursorAccent: '#1e1e1e'
                }
            });
            
            // Disable all input handling
            term.onData(() => {});
            term.onKey(() => {});
            term.onSelectionChange(() => {});
            term.open(container);
            
            // Clear any initialization artifacts
            setTimeout(() => {
                term.clear();
            }, 100);
            
            terminals[jobId] = { term: term, outputLength: 0 };
        }

        function updateJobCard(job) {
            const jobsGrid = document.getElementById('jobsGrid');
            let jobCard = document.getElementById('job-card-' + job.id);

            if (!jobCard) {
                jobCard = document.createElement('div');
                jobCard.className = 'job-card';
                jobCard.id = 'job-card-' + job.id;
                
                jobCard.innerHTML = \`
                    <div class="job-header">
                        <div class="job-name">\${job.command} \${job.args.join(' ')}</div>
                        <div class="job-status"></div>
                    </div>
                    <div class="job-schedule">Schedule: \${job.schedule}</div>
                    <div class="job-actions">
                        <button class="btn btn-primary" onclick="runJob('\${job.id}')">Run Now</button>
                    </div>
                    <div class="terminal-container" id="terminal-\${job.id}"></div>
                \`;
                jobsGrid.appendChild(jobCard);
                initTerminal(job.id);
            }

            // Update status
            const statusElement = jobCard.querySelector('.job-status');
            const statusClass = job.status === 'running' ? 'status-running' :
                              job.status === 'completed' ? 'status-completed' : 'status-failed';
            statusElement.className = 'job-status ' + statusClass;
            statusElement.textContent = job.status;
        }

        async function updateDashboard() {
            try {
                const response = await fetch('/api/jobs');
                const data = await response.json();
                data.jobs.forEach(job => updateJobCard(job));
            } catch (error) {
                console.error('Error updating dashboard:', error);
            }
        }

        function runJob(jobId) {
            fetch('/api/run?job=' + encodeURIComponent(jobId), { method: 'POST' })
                .then(response => response.json())
                .then(data => {
                    if (data.success) {
                        // Immediately clear the terminal for the job that was just run
                        if (terminals[jobId]) {
                            terminals[jobId].term.clear();
                            terminals[jobId].outputLength = 0;
                        }
                        updateDashboard();
                    } else {
                        alert('Failed to run job: ' + data.error);
                    }
                })
                .catch(error => console.error('Error running job:', error));
        }

        function updateJobOutput(jobId) {
            const currentLength = terminals[jobId] ? terminals[jobId].outputLength : 0;
            fetch(\`/api/job?name=\${encodeURIComponent(jobId)}&since=\${currentLength}\`)
                .then(response => response.json())
                .then(data => {
                    if (data.logReset) {
                        terminals[jobId].term.clear();
                    }
                    if (data.output) {
                        terminals[jobId].term.write(data.output);
                        terminals[jobId].outputLength = data.outputLength;
                    }
                })
                .catch(error => console.error('Error fetching job output:', error));
        }

        // Initial dashboard load
        updateDashboard();

        // Update dashboard and outputs periodically
        setInterval(updateDashboard, 2000);
        setInterval(() => {
            Object.keys(terminals).forEach(jobId => {
                updateJobOutput(jobId);
            });
        }, 1000);
    </script>
</body>
</html>`;

    return new Response(html, {
      headers: { "Content-Type": "text/html" },
    });
  }

  private handleJobsApi(): Response {
    const jobs = this.config.jobs.map((job, index) => {
      const runningJob = this.runningJobs.get(index);
      const completedJob = this.completedJobs.find((j) => j.jobIndex === index);

      let status = "idle";
      if (runningJob) {
        status = "running";
      } else if (completedJob) {
        status = completedJob.status;
      }

      return {
        id: index,
        command: job.command,
        args: job.args,
        schedule: job.schedule,
        status: status,
      };
    });

    return new Response(JSON.stringify({ jobs }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private handleJobApi(url: URL): Response {
    const jobIdStr = url.searchParams.get("name"); // keeping param name same for compatibility
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
    const job =
      this.runningJobs.get(jobIndex) ||
      this.completedJobs.find((j) => j.jobIndex === jobIndex);

    if (job) {
      const fullOutput = job.output || "";
      let partialOutput = "";
      let logReset = false;

      // If the client's output length is greater than the server's, the job has restarted.
      if (since > 0 && since > fullOutput.length) {
        partialOutput = fullOutput;
        logReset = true;
      } else {
        partialOutput = fullOutput.substring(since);
      }

      return new Response(
        JSON.stringify({
          id: job.jobIndex, // change to id
          status: job.status,
          startTime: job.startTime,
          endTime: job.endTime,
          output: partialOutput,
          outputLength: fullOutput.length,
          logReset: logReset,
          exitCode: job.exitCode,
          error: job.error,
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
