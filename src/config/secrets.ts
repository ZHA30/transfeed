type SecretMap = Record<string, string>;

const TOKEN_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

export function expandEnvTokens(value: string): string {
  return value.replace(TOKEN_PATTERN, (token, name: string) => {
    const resolved = getSecretValue(name);
    if (resolved === undefined) {
      throw new Error(`missing environment value for ${token}`);
    }
    return resolved;
  });
}

function getSecretValue(name: string): string | undefined {
  return process.env[name] ?? readSecretMap()[name];
}

let secretMap: SecretMap | undefined;

function readSecretMap(): SecretMap {
  if (secretMap) {
    return secretMap;
  }
  const raw = process.env.TRANSFEED_SECRET_ENV;
  if (!raw) {
    secretMap = {};
    return secretMap;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!isSecretMap(parsed)) {
    throw new Error("TRANSFEED_SECRET_ENV must be a JSON object with string values");
  }
  secretMap = parsed;
  return secretMap;
}

function isSecretMap(value: unknown): value is SecretMap {
  return typeof value === "object"
    && value !== null
    && Object.values(value).every((entry) => typeof entry === "string");
}
