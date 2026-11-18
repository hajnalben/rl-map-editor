// For the type check (npm run types): what the page adds to window, and the browser's file pickers, which
// TypeScript's DOM types leave out (Chrome and Edge have them)
interface Window {
  editor: any;                                    // for tests in the console
  mapAI: any;                                     // AI agents' API (ai.js)
  showSaveFilePicker?: typeof showSaveFilePicker;
  showDirectoryPicker?: typeof showDirectoryPicker;
}
declare function showSaveFilePicker(options?: object): Promise<FileSystemFileHandle>;
declare function showDirectoryPicker(options?: object): Promise<FileSystemDirectoryHandle>;
interface FileSystemHandle {
  queryPermission(options?: object): Promise<PermissionState>;
  requestPermission(options?: object): Promise<PermissionState>;
}
interface FileSystemDirectoryHandle {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
}
