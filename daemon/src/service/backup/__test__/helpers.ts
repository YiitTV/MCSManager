import { BackupStorage } from "../index_store";

/** In-memory storage for tests. */
export class MemoryBackupStorage implements BackupStorage {
  readonly data = new Map<string, any>();
  store(category: string, uuid: string, object: any) {
    this.data.set(`${category}/${uuid}`, JSON.parse(JSON.stringify(object)));
  }
  load(category: string, classz: any, uuid: string) {
    const v = this.data.get(`${category}/${uuid}`);
    if (!v) return null;
    return Object.assign(new classz(), JSON.parse(JSON.stringify(v)));
  }
  list(category: string) {
    return [...this.data.keys()]
      .filter((k) => k.startsWith(category + "/"))
      .map((k) => k.slice(category.length + 1));
  }
  delete(category: string, uuid: string) {
    this.data.delete(`${category}/${uuid}`);
  }
}
