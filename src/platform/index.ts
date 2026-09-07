/**
 * File I/O, abstracted over Tauri and the plain browser.
 *
 * The app is developed in a browser tab (`npm run dev`) and shipped as a Tauri
 * window; keeping every filesystem touch behind this module is what lets the same
 * engine code serve both without conditionals scattered through the UI.
 */

type TauriDialog = {
  open(opts: unknown): Promise<string | string[] | null>;
  save(opts: unknown): Promise<string | null>;
};
type TauriFs = {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  writeTextFile(path: string, data: string): Promise<void>;
  readTextFile(path: string): Promise<string>;
};

export const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

async function dialog(): Promise<TauriDialog> {
  return (await import('@tauri-apps/plugin-dialog')) as unknown as TauriDialog;
}
async function fs(): Promise<TauriFs> {
  return (await import('@tauri-apps/plugin-fs')) as unknown as TauriFs;
}

export type PickedFile = { name: string; bytes: Uint8Array; path?: string };

/**
 * Formats the desktop shell can decode natively. In the browser this is just
 * what the web view supports; under Tauri, Rust adds TIFF, which print work
 * frequently arrives as.
 */
export async function supportedImageExtensions(): Promise<string[]> {
  const web = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];
  if (!isTauri()) return web;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<string[]>('native_image_formats');
  } catch {
    return web;
  }
}

/**
 * Decode an image the web view cannot handle, via the Rust `image` crate.
 * Returns null when the file is one the browser can decode itself, so the
 * caller keeps using the faster built-in path.
 */
export async function decodeNative(
  path: string,
): Promise<{ width: number; height: number; rgba: Uint8Array } | null> {
  if (!isTauri()) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  const res = await invoke<{ width: number; height: number; rgba: number[] }>('decode_image', { path });
  return { width: res.width, height: res.height, rgba: new Uint8Array(res.rgba) };
}

/** Browser fallback: a transient `<input type=file>`. */
function browserPick(accept: string, multiple = false): Promise<PickedFile[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = async () => {
      const files = Array.from(input.files ?? []);
      resolve(
        await Promise.all(
          files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })),
        ),
      );
    };
    // Safari will not fire `change` for a detached input.
    input.style.display = 'none';
    document.body.appendChild(input);
    input.click();
    setTimeout(() => input.remove(), 60_000);
  });
}

export async function openFile(
  filters: { name: string; extensions: string[] }[],
): Promise<PickedFile | null> {
  if (isTauri()) {
    const d = await dialog();
    const path = (await d.open({ multiple: false, filters })) as string | null;
    if (!path) return null;
    const f = await fs();
    return { name: path.split('/').pop() ?? path, bytes: await f.readFile(path), path };
  }
  const accept = filters.flatMap((f) => f.extensions.map((e) => `.${e}`)).join(',');
  const picked = await browserPick(accept);
  return picked[0] ?? null;
}

export async function saveFile(
  data: Uint8Array | string,
  defaultName: string,
  filters: { name: string; extensions: string[] }[],
): Promise<boolean> {
  if (isTauri()) {
    const d = await dialog();
    const path = await d.save({ defaultPath: defaultName, filters });
    if (!path) return false;
    const f = await fs();
    if (typeof data === 'string') await f.writeTextFile(path, data);
    else await f.writeFile(path, data);
    return true;
  }

  // Browsers cannot silently write to disk; hand the file to the download flow.
  const blob = typeof data === 'string'
    ? new Blob([data], { type: 'text/plain' })
    : new Blob([data.slice().buffer as ArrayBuffer]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = defaultName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}
