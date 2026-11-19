import { errorText } from "@/hooks/useBackupPlanForm";
import {
  checkBackupName,
  checkLocalDirectory,
  checkRedirectBaseUrl,
  checkS3Endpoint
} from "@/tools/backupValidation";
import {
  BACKUP_LIMITS,
  BACKUP_SECRET_MASK,
  type BackupDestination,
  type BackupDestinationType,
  type GDriveAuthMethod
} from "@/types/backup";

const GB = 1024 * 1024 * 1024;

export interface DestinationFormState {
  id?: string;
  type: BackupDestinationType;
  name: string;
  // local
  directory: string;
  maxTotalGb: number;
  // s3
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  pathStyle: boolean;
  allowPrivateNetwork: boolean;
  accessKeyId: string;
  // gdrive
  authMethod: GDriveAuthMethod;
  clientId: string;
  folderId: string;
  connectedEmail: string;
  redirectBaseUrl: string;
  /** Secret inputs: always empty when editing; a typed value replaces the stored one. */
  secretInputs: { secretAccessKey: string; clientSecret: string; serviceAccountJson: string };
  /** Which secrets already exist on the panel (their value is never shown). */
  hasSecret: {
    secretAccessKey: boolean;
    clientSecret: boolean;
    refreshToken: boolean;
    serviceAccountJson: boolean;
  };
}

export function createDestinationFormState(): DestinationFormState {
  return {
    type: "local",
    name: "",
    directory: "",
    maxTotalGb: 50,
    endpoint: "",
    region: "us-east-1",
    bucket: "",
    prefix: "",
    pathStyle: false,
    allowPrivateNetwork: false,
    accessKeyId: "",
    authMethod: "oauth",
    clientId: "",
    folderId: "",
    connectedEmail: "",
    redirectBaseUrl: typeof window !== "undefined" ? window.location.origin : "",
    secretInputs: { secretAccessKey: "", clientSecret: "", serviceAccountJson: "" },
    hasSecret: {
      secretAccessKey: false,
      clientSecret: false,
      refreshToken: false,
      serviceAccountJson: false
    }
  };
}

const isSet = (v: unknown) => typeof v === "string" && v.length > 0;

export function destinationToFormState(d: BackupDestination): DestinationFormState {
  const f = createDestinationFormState();
  f.id = d.id;
  f.type = d.type;
  f.name = d.name;
  const c = d.config ?? {};
  f.directory = c.directory ?? "";
  f.maxTotalGb = c.maxTotalBytes ? Math.max(1, Math.round(c.maxTotalBytes / GB)) : 50;
  f.endpoint = c.endpoint ?? "";
  f.region = c.region ?? "us-east-1";
  f.bucket = c.bucket ?? "";
  f.prefix = c.prefix ?? "";
  f.pathStyle = !!c.pathStyle;
  f.allowPrivateNetwork = !!c.allowPrivateNetwork;
  f.accessKeyId = c.accessKeyId ?? "";
  f.authMethod = c.authMethod ?? "oauth";
  f.clientId = c.clientId ?? "";
  f.folderId = c.folderId ?? "";
  f.connectedEmail = c.connectedEmail ?? "";
  f.redirectBaseUrl = c.redirectBaseUrl ?? f.redirectBaseUrl;
  const s = d.secrets ?? {};
  f.hasSecret = {
    secretAccessKey: isSet(s.secretAccessKey),
    clientSecret: isSet(s.clientSecret),
    refreshToken: isSet(s.refreshToken),
    serviceAccountJson: isSet(s.serviceAccountJson)
  };
  return f;
}

/** Secret value to send: typed value, else the mask when one is already stored, else empty. */
function secretValue(input: string, stored: boolean): string {
  if (input) return input;
  return stored ? BACKUP_SECRET_MASK : "";
}

function checkServiceAccountJson(value: string): boolean {
  if (value.length > BACKUP_LIMITS.MAX_SERVICE_ACCOUNT_JSON_LENGTH) return false;
  try {
    const parsed = JSON.parse(value);
    return (
      typeof parsed?.client_email === "string" &&
      /^[^\s@]+@[^\s@]+$/.test(parsed.client_email) &&
      typeof parsed?.private_key === "string" &&
      parsed.private_key.includes("PRIVATE KEY")
    );
  } catch {
    return false;
  }
}

export function validateDestinationForm(f: DestinationFormState): Record<string, string> {
  const errors: Record<string, string> = {};
  const set = (field: string, code: string | null) => {
    if (code) errors[field] = errorText(code);
  };
  set("name", checkBackupName(f.name));
  if (f.type === "local") {
    set("directory", checkLocalDirectory(f.directory));
    if (!Number.isFinite(f.maxTotalGb) || f.maxTotalGb <= 0) set("maxTotalGb", "maxSize");
  } else if (f.type === "s3") {
    set("endpoint", checkS3Endpoint(f.endpoint, f.allowPrivateNetwork));
    if (!/^[A-Za-z0-9-]{1,32}$/.test(f.region)) set("region", "region");
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(f.bucket)) set("bucket", "bucket");
    if (
      f.prefix &&
      (!/^[A-Za-z0-9._\-/]+$/.test(f.prefix) ||
        f.prefix.startsWith("/") ||
        f.prefix.includes("//") ||
        f.prefix.split("/").some((s) => s === ".." || s === "."))
    ) {
      set("prefix", "prefix");
    }
    if (!/^[A-Za-z0-9_.\-/+=]{3,128}$/.test(f.accessKeyId)) set("accessKeyId", "accessKey");
    if (!f.secretInputs.secretAccessKey && !f.hasSecret.secretAccessKey) {
      set("secretAccessKey", "secretMissing");
    }
  } else {
    if (f.folderId && !/^[A-Za-z0-9_-]{10,100}$/.test(f.folderId)) set("folderId", "folderId");
    if (f.authMethod === "oauth") {
      if (!/^[A-Za-z0-9._-]{5,256}$/.test(f.clientId)) set("clientId", "clientId");
      set("redirectBaseUrl", checkRedirectBaseUrl(f.redirectBaseUrl));
      if (!f.secretInputs.clientSecret && !f.hasSecret.clientSecret) {
        set("clientSecret", "secretMissing");
      }
    } else {
      if (!f.folderId) set("folderId", "folderId");
      const json = f.secretInputs.serviceAccountJson;
      if (json) {
        if (!checkServiceAccountJson(json)) set("serviceAccountJson", "serviceAccount");
      } else if (!f.hasSecret.serviceAccountJson) {
        set("serviceAccountJson", "secretMissing");
      }
    }
  }
  return errors;
}

/** Build the request body. Stored secrets are sent back as the mask so the panel keeps them. */
export function destinationFormToPayload(f: DestinationFormState): BackupDestination {
  const base = { id: f.id as string, type: f.type, name: f.name.trim() };
  if (f.type === "local") {
    return {
      ...base,
      config: { directory: f.directory.trim(), maxTotalBytes: Math.round(f.maxTotalGb * GB) },
      secrets: {}
    };
  }
  if (f.type === "s3") {
    return {
      ...base,
      config: {
        endpoint: f.endpoint.trim(),
        region: f.region.trim(),
        bucket: f.bucket.trim(),
        ...(f.prefix.trim() ? { prefix: f.prefix.trim() } : {}),
        pathStyle: f.pathStyle,
        allowPrivateNetwork: f.allowPrivateNetwork,
        accessKeyId: f.accessKeyId.trim()
      },
      secrets: {
        secretAccessKey: secretValue(f.secretInputs.secretAccessKey, f.hasSecret.secretAccessKey)
      }
    };
  }
  if (f.authMethod === "oauth") {
    return {
      ...base,
      config: {
        authMethod: "oauth",
        clientId: f.clientId.trim(),
        redirectBaseUrl: f.redirectBaseUrl.trim(),
        ...(f.folderId.trim() ? { folderId: f.folderId.trim() } : {})
      },
      secrets: {
        // The refresh token is only ever set by the Google callback; clients cannot send it.
        clientSecret: secretValue(f.secretInputs.clientSecret, f.hasSecret.clientSecret)
      }
    };
  }
  return {
    ...base,
    config: { authMethod: "service_account", folderId: f.folderId.trim() },
    secrets: {
      serviceAccountJson: secretValue(
        f.secretInputs.serviceAccountJson,
        f.hasSecret.serviceAccountJson
      )
    }
  };
}
