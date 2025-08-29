export class ConfigError extends Error {
  readonly tag = "CONFIG" as const;
  hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = "ConfigError";
    this.hint = hint;
  }
}

export class PolicyError extends Error {
  readonly tag = "POLICY" as const;
  details?: string[];
  constructor(message: string, details?: string[]) {
    super(message);
    this.name = "PolicyError";
    this.details = details;
  }
}

export class QuotaError extends Error {
  readonly tag = "QUOTA" as const;
  kind: "daily" | "rpm";
  limit?: number;
  when?: string;
  constructor(kind: "daily" | "rpm", message: string, limit?: number, when?: string) {
    super(message);
    this.name = "QuotaError";
    this.kind = kind;
    this.limit = limit;
    this.when = when;
  }
}

export class GatewayError extends Error {
  readonly tag = "GATEWAY" as const;
  status?: number;
  body?: string;
  constructor(message: string, status?: number, body?: string) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
    this.body = body;
  }
}

export class RouterError extends Error {
  readonly tag = "ROUTER" as const;
  attempts: Array<{ model: string; message: string; status?: number }>;
  constructor(message: string, attempts: Array<{ model: string; message: string; status?: number }>) {
    super(message);
    this.name = "RouterError";
    this.attempts = attempts;
  }
}

export function printFriendlyError(err: any): number {
  // Returns suggested exit code
  const w = (s: string) => process.stderr.write(s + "\n");
  const sep = () => w("");
  if (err instanceof ConfigError) {
    w(`ERROR [config]: ${err.message}`);
    if (err.hint) w(`hint: ${err.hint}`);
    return 78; // EX_CONFIG
  }
  if (err instanceof PolicyError) {
    w(`ERROR [policy]: ${err.message}`);
    if (err.details?.length) err.details.forEach((d) => w(` - ${d}`));
    return 65; // EX_DATAERR
  }
  if (err instanceof QuotaError) {
    w(`ERROR [quota/${err.kind}]: ${err.message}`);
    if (err.when) w(`resets: ${err.when}`);
    return 75; // EX_TEMPFAIL
  }
  if (err instanceof GatewayError) {
    w(`ERROR [gateway]: ${err.message}`);
    if (err.status) w(`status: ${err.status}`);
    if (err.body) w(`body: ${err.body}`);
    return 69; // EX_UNAVAILABLE
  }
  if (err instanceof RouterError) {
    w(`ERROR [router]: ${err.message}`);
    if (err.attempts?.length) {
      for (const a of err.attempts) {
        w(` - model=${a.model} err=${a.message}${a.status ? ` (status ${a.status})` : ""}`);
      }
    }
    return 69;
  }
  // Fallback
  const msg = (err && (err.message || String(err))) || "Unknown error";
  w(`ERROR: ${msg}`);
  return 1;
}

