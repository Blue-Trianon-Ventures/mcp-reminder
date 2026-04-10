import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "./log.js";

const run = promisify(execFile);

export interface ReminderItem {
  id: string;
  name: string;
  completed: boolean;
  dueDate: string | null;
  notes: string | null;
  list: string;
}

export interface ReminderList {
  name: string;
  id: string;
  count: number;
}

// Use batch property access on JXA collection specifiers — calling .id(), .name()
// etc. on the collection returns arrays of all values in one Apple Event, which is
// orders of magnitude faster than per-item iteration.
async function jxa(op: string, script: string): Promise<string> {
  try {
    const start = Date.now();
    const { stdout } = await run("osascript", ["-l", "JavaScript", "-e", script], {
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    log.info(`${op} ok (${Date.now() - start}ms)`);
    return stdout.trim();
  } catch (err: any) {
    const msg = err.stderr || err.message || String(err);
    log.error(`${op} failed: ${msg}`);
    throw new Error(msg);
  }
}

export async function listLists(): Promise<ReminderList[]> {
  const out = await jxa("list_lists",
    'var app = Application("Reminders"); var L = app.lists; ' +
    'var names = L.name(); var ids = L.id(); var counts = []; ' +
    'for (var i = 0; i < names.length; i++) counts.push(app.lists[i].reminders().length); ' +
    'JSON.stringify(names.map(function(n, i) { return { name: n, id: ids[i], count: counts[i] }; }));'
  );
  return JSON.parse(out);
}

export async function getItems(
  listName: string,
  includeCompleted: boolean = false
): Promise<ReminderItem[]> {
  const ln = JSON.stringify(listName);
  const out = await jxa(`get_items(${listName})`,
    `var app = Application("Reminders"); var r = app.lists.byName(${ln}).reminders; ` +
    'var ids = r.id(); var names = r.name(); var comp = r.completed(); var bodies = r.body(); var dates = r.dueDate(); ' +
    `var arr = []; for (var i = 0; i < ids.length; i++) { ` +
    `if (!${includeCompleted} && comp[i]) continue; ` +
    `arr.push({ id: ids[i], name: names[i], completed: comp[i], dueDate: dates[i] ? dates[i].toISOString() : null, notes: bodies[i] || null, list: ${ln} }); } ` +
    'JSON.stringify(arr);'
  );
  return JSON.parse(out);
}

export async function addItem(
  listName: string,
  name: string,
  options?: { notes?: string; dueDate?: string }
): Promise<ReminderItem> {
  const ln = JSON.stringify(listName);
  const props: string[] = [`name: ${JSON.stringify(name)}`];
  if (options?.notes) props.push(`body: ${JSON.stringify(options.notes)}`);
  if (options?.dueDate) props.push(`dueDate: new Date(${JSON.stringify(options.dueDate)})`);

  const out = await jxa(`add_item(${listName}, ${name})`,
    `var app = Application("Reminders"); var list = app.lists.byName(${ln}); ` +
    `var r = app.Reminder({${props.join(", ")}}); list.reminders.push(r); ` +
    `var dd = null; try { var d = r.dueDate(); if (d) dd = d.toISOString(); } catch(e) {} ` +
    `var notes = null; try { notes = r.body() || null; } catch(e) {} ` +
    `JSON.stringify({ id: r.id(), name: r.name(), completed: r.completed(), dueDate: dd, notes: notes, list: ${ln} });`
  );
  return JSON.parse(out);
}

export async function completeItem(
  listName: string,
  itemId: string
): Promise<{ success: boolean; id: string }> {
  const out = await jxa("complete_item",
    `var app = Application("Reminders"); var list = app.lists.byName(${JSON.stringify(listName)}); ` +
    `var items = list.reminders; var ids = items.id(); var idx = ids.indexOf(${JSON.stringify(itemId)}); ` +
    `if (idx === -1) throw new Error("Reminder not found"); ` +
    `items[idx].completed = true; JSON.stringify({ success: true, id: ${JSON.stringify(itemId)} });`
  );
  return JSON.parse(out);
}

export async function uncompleteItem(
  listName: string,
  itemId: string
): Promise<{ success: boolean; id: string }> {
  const out = await jxa("uncomplete_item",
    `var app = Application("Reminders"); var list = app.lists.byName(${JSON.stringify(listName)}); ` +
    `var items = list.reminders; var ids = items.id(); var idx = ids.indexOf(${JSON.stringify(itemId)}); ` +
    `if (idx === -1) throw new Error("Reminder not found"); ` +
    `items[idx].completed = false; JSON.stringify({ success: true, id: ${JSON.stringify(itemId)} });`
  );
  return JSON.parse(out);
}

export async function deleteItem(
  listName: string,
  itemId: string
): Promise<{ success: boolean; id: string }> {
  const out = await jxa("delete_item",
    `var app = Application("Reminders"); var list = app.lists.byName(${JSON.stringify(listName)}); ` +
    `var items = list.reminders; var ids = items.id(); var idx = ids.indexOf(${JSON.stringify(itemId)}); ` +
    `if (idx === -1) throw new Error("Reminder not found"); ` +
    `app.delete(items[idx]); JSON.stringify({ success: true, id: ${JSON.stringify(itemId)} });`
  );
  return JSON.parse(out);
}
