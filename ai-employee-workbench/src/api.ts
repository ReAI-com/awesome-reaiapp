export class RequestError extends Error {
  constructor(message: string, public readonly status: number) { super(message); this.name = 'RequestError'; }
}

export async function request<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      "X-Workbench-Request": "1",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && path !== '/api/auth/session') window.dispatchEvent(new Event('workbench:unauthorized'));
  if (!response.ok)
    throw new RequestError(
      typeof data.error === "string"
        ? data.error
        : data.error?.message ||
          data.message ||
          `请求未完成 (${response.status})`,
      response.status,
    );
  return data as T;
}

export function uploadFiles(
  path: string,
  files: File[],
  onProgress: (progress: number) => void,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const file of files) form.append("files", file);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    xhr.setRequestHeader("X-Workbench-Request", "1");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable)
        onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onerror = () => reject(new Error("上传连接中断，请重试。"));
    xhr.onabort = () => reject(new Error("上传已取消。"));
    xhr.onload = () => {
      let result: { error?: string } = {};
      try {
        result = JSON.parse(xhr.responseText);
      } catch {
        /* preserve HTTP error */
      }
      if (xhr.status === 401) window.dispatchEvent(new Event('workbench:unauthorized'));
      if (xhr.status >= 200 && xhr.status < 300) resolve(result);
      else reject(new Error(result.error || `上传未完成 (${xhr.status})`));
    };
    xhr.send(form);
  });
}

export const time = (value: string) =>
  new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
export const bytes = (value: number) =>
  value < 1024
    ? `${value} B`
    : value < 1024 * 1024
      ? `${(value / 1024).toFixed(1)} KB`
      : `${(value / 1024 / 1024).toFixed(1)} MB`;
export const pretty = (value: unknown) => JSON.stringify(value, null, 2);
export const valueText = (value: unknown): string =>
  value == null
    ? "—"
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
export const activeStatus = (value: string) =>
  ["queued", "running", "waiting_review"].includes(value);
