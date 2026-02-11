import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export interface LaunchdInstallOptions {
  label: string;
  executable: string;
  args?: string[];
  workingDirectory: string;
  stdoutPath: string;
  stderrPath: string;
  env?: Record<string, string>;
}

export interface ServiceStatus {
  installed: boolean;
  running: boolean;
  raw: string;
}

function plistPathForLabel(label: string): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
}

function launchctlDomain(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return `gui/${uid}`;
}

function runLaunchctl(args: string[]): { ok: boolean; stdout: string; stderr: string; status: number } {
  const proc = spawnSync('launchctl', args, { encoding: 'utf8' });
  return {
    ok: proc.status === 0,
    stdout: proc.stdout || '',
    stderr: proc.stderr || '',
    status: proc.status ?? -1,
  };
}

function buildPlistXML(opts: LaunchdInstallOptions): string {
  const escapedArgs = [opts.executable, ...(opts.args || [])].map((s) => s.replace(/&/g, '&amp;'));
  const envBlock = Object.entries(opts.env || {})
    .map(([k, v]) => `    <key>${k}</key>\n    <string>${v.replace(/&/g, '&amp;')}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${opts.label}</string>

  <key>ProgramArguments</key>
  <array>
${escapedArgs.map((arg) => `    <string>${arg}</string>`).join('\n')}
  </array>

  <key>WorkingDirectory</key>
  <string>${opts.workingDirectory.replace(/&/g, '&amp;')}</string>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${opts.stdoutPath.replace(/&/g, '&amp;')}</string>
  <key>StandardErrorPath</key>
  <string>${opts.stderrPath.replace(/&/g, '&amp;')}</string>
${envBlock ? `
  <key>EnvironmentVariables</key>
  <dict>
${envBlock}
  </dict>` : ''}

  <key>ThrottleInterval</key>
  <integer>5</integer>
</dict>
</plist>
`;
}

export class LaunchdServiceManager {
  private readonly label: string;

  constructor(label: string) {
    this.label = label;
  }

  get plistPath(): string {
    return plistPathForLabel(this.label);
  }

  install(opts: Omit<LaunchdInstallOptions, 'label'>): void {
    fs.mkdirSync(path.dirname(this.plistPath), { recursive: true });
    fs.mkdirSync(path.dirname(opts.stdoutPath), { recursive: true });
    fs.mkdirSync(path.dirname(opts.stderrPath), { recursive: true });

    fs.writeFileSync(this.plistPath, buildPlistXML({ ...opts, label: this.label }), 'utf8');

    runLaunchctl(['bootout', `${launchctlDomain()}/${this.label}`]);
    runLaunchctl(['bootstrap', launchctlDomain(), this.plistPath]);
  }

  start(): void {
    const domainLabel = `${launchctlDomain()}/${this.label}`;
    const kicked = runLaunchctl(['kickstart', '-k', domainLabel]);
    if (kicked.ok) {
      return;
    }
    // If service was previously bootout-ed, re-bootstrap from plist then kickstart.
    if (fs.existsSync(this.plistPath)) {
      runLaunchctl(['bootstrap', launchctlDomain(), this.plistPath]);
      runLaunchctl(['kickstart', '-k', domainLabel]);
    }
  }

  stop(): void {
    runLaunchctl(['bootout', `${launchctlDomain()}/${this.label}`]);
  }

  restart(): void {
    this.start();
  }

  uninstall(): void {
    runLaunchctl(['bootout', `${launchctlDomain()}/${this.label}`]);
    if (fs.existsSync(this.plistPath)) {
      fs.unlinkSync(this.plistPath);
    }
  }

  status(): ServiceStatus {
    const proc = runLaunchctl(['print', `${launchctlDomain()}/${this.label}`]);
    const raw = `${proc.stdout}${proc.stderr}`.trim();
    const installed = fs.existsSync(this.plistPath);
    const running = proc.ok && /state = running/.test(raw);
    return {
      installed,
      running,
      raw,
    };
  }
}
