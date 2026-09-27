import { execFile } from "node:child_process";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { availableParallelism } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseArgs, promisify } from "node:util";

export type Rendered = { source: string; file: string; prompt: string };
export type Render = {
  model: string;
  rendered: Rendered | undefined;
  censored: boolean;
};
export type Image = { name: string; path: string; renders: Render[] };
type Source = {
  renders: string;
  models: string[];
  dir: string;
  censored: Set<string>;
};
export type ImageOptions = { width: number; height: number; quality: number };
export type Group = { name: string; images: Image[]; pending: number };
export type Study = { name: string; groups: Group[] };
export type Category = { name: string; studies: Study[] };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const BATCH_SUFFIX = ".md";
const IMAGE_WIDTH = 608;
const IMAGE_HEIGHT = 800;
const DISPLAY_WIDTH = IMAGE_WIDTH / 2;
const CARD_BORDER = 1;
const TITLE = "Krea-2 — Qwen-Image-2.1 study";
const TAGLINE = "Identical prompts, vanilla ComfyUI workflows";
const LINKS = [
  {
    label: "Krea 2 ComfyUI tutorial",
    href: "https://docs.comfy.org/tutorials/image/krea/krea-2",
  },
  {
    label: "Qwen-Image 2.1 ComfyUI tutorial",
    href: "https://docs.comfy.org/tutorials/image/qwen/qwen-image-2-1",
  },
  {
    label: "Source on GitHub",
    href: "https://github.com/Pyrolistical/krea-2-qwen-image-2-1-study",
  },
];
const RENDER_GAP = 2;
const PROMPT_INPUTS: Record<string, string> = {
  CLIPTextEncode: "text",
  TextEncodeQwenImage21: "prompt",
};

export function pngText(
  bytes: Uint8Array,
  keyword: string,
): string | undefined {
  if (!PNG_SIGNATURE.every((byte, position) => bytes[position] === byte)) {
    throw new Error("not a png");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const latin1 = new TextDecoder("latin1");
  let offset = PNG_SIGNATURE.length;
  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    const type = latin1.decode(bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "tEXt") {
      const separator = data.indexOf(0);
      if (latin1.decode(data.subarray(0, separator)) === keyword) {
        return latin1.decode(data.subarray(separator + 1));
      }
    }
    offset += 12 + length;
  }
  return;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function promptOf(png: Uint8Array): string {
  const text = pngText(png, "prompt");
  if (text === undefined) {
    throw new Error("png has no prompt");
  }
  const workflow: unknown = JSON.parse(text);
  if (!isRecord(workflow)) {
    throw new Error("png prompt is not a workflow");
  }
  const prompts = Object.values(workflow).flatMap((node) => {
    if (!isRecord(node) || typeof node.class_type !== "string") {
      return [];
    }
    const input = PROMPT_INPUTS[node.class_type];
    const inputs = node.inputs;
    if (input === undefined || !isRecord(inputs)) {
      return [];
    }
    const prompt = inputs[input];
    return typeof prompt === "string" ? [prompt] : [];
  });
  if (prompts.length !== 1) {
    throw new Error(`expected 1 text prompt, found ${prompts.length}`);
  }
  return prompts[0];
}

function byName(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

function titleOf(slug: string): string {
  return slug.replaceAll("-", " ");
}

export function batchImages(markdown: string): string[] {
  return [...markdown.matchAll(/^# (.+\.png)$/gm)].map((match) => match[1]);
}

async function readRender(
  { renders, dir, censored }: Source,
  study: string,
  path: string,
  model: string,
): Promise<Render> {
  if (censored.has(`${model}/${study}/${path}`)) {
    return { model, rendered: undefined, censored: true };
  }
  const source = join(renders, model, dir, study, path);
  if ((await modifiedAt(source)) === undefined) {
    return { model, rendered: undefined, censored: false };
  }
  return {
    model,
    censored: false,
    rendered: {
      source,
      file: `${model}/${study}/${path.replace(/\.png$/, ".webp")}`,
      prompt: promptOf(await readFile(source)),
    },
  };
}

async function readGroup(
  source: Source,
  study: string,
  batch: string,
): Promise<Group> {
  const markdown = await readFile(join(source.dir, study, batch), "utf8");
  const all = await Promise.all(
    batchImages(markdown).map(async (path) => ({
      name: titleOf(basename(path, ".png")),
      path: `${study}/${path}`,
      renders: await Promise.all(
        source.models.map((model) => readRender(source, study, path, model)),
      ),
    })),
  );
  const images = all.filter((image) =>
    image.renders.some(
      (render) => render.rendered !== undefined || render.censored,
    ),
  );
  const pending = all
    .flatMap((image) => image.renders)
    .filter(
      (render) => render.rendered === undefined && !render.censored,
    ).length;
  return { name: groupNameOf(batch), images, pending };
}

export function groupNameOf(batch: string): string {
  return batch.slice(0, -BATCH_SUFFIX.length).replace(/^\d+-/, "");
}

async function readStudy(source: Source, name: string): Promise<Study> {
  const batches = (await readdir(join(source.dir, name)))
    .filter((file) => file.endsWith(BATCH_SUFFIX))
    .sort(byName);
  const groups = await Promise.all(
    batches.map((batch) => readGroup(source, name, batch)),
  );
  return { name, groups };
}

export type CategoryOrder = { name: string; studies: string[] }[];

export function checkCategories(order: CategoryOrder, names: string[]): void {
  const listed = order.flatMap((category) => category.studies);
  const duplicate = listed.find(
    (name, position) => listed.indexOf(name) !== position,
  );
  if (duplicate !== undefined) {
    throw new Error(`study ${duplicate} is in more than one category`);
  }
  const missing = listed.filter((name) => !names.includes(name));
  if (missing.length > 0) {
    throw new Error(`categories list missing studies: ${missing.join(", ")}`);
  }
  const unlisted = names.filter((name) => !listed.includes(name));
  if (unlisted.length > 0) {
    throw new Error(`studies not in a category: ${unlisted.join(", ")}`);
  }
}

export async function readModels(renders: string): Promise<string[]> {
  const entries = await readdir(renders, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(byName);
}

export async function readCensored(dir: string): Promise<Set<string>> {
  const json: unknown = JSON.parse(
    await readFile(join(dir, "censored.json"), "utf8"),
  );
  if (!isRecord(json)) {
    throw new Error("censored.json expected an object of model to images");
  }
  return new Set(
    Object.entries(json).flatMap(([model, paths]) => {
      if (
        !Array.isArray(paths) ||
        !paths.every((path) => typeof path === "string")
      ) {
        throw new Error(`censored.json ${model} expected a list of images`);
      }
      return paths.map((path) => `${model}/${path}`);
    }),
  );
}

export function checkCensored(
  censored: Set<string>,
  categories: Category[],
): void {
  const known = new Set(
    imagesOf(categories.flatMap((category) => category.studies)).flatMap(
      (image) => image.renders.map((render) => `${render.model}/${image.path}`),
    ),
  );
  const unknown = [...censored].filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `censored.json lists unknown images: ${unknown.join(", ")}`,
    );
  }
}

export async function readCategories(source: Source): Promise<Category[]> {
  const { dir } = source;
  const order: CategoryOrder = JSON.parse(
    await readFile(join(dir, "categories.json"), "utf8"),
  );
  const entries = await readdir(dir, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  checkCategories(order, names);
  return Promise.all(
    order.map(async (category) => ({
      name: category.name,
      studies: await Promise.all(
        category.studies.map((name) => readStudy(source, name)),
      ),
    })),
  );
}

export function renderedOf(images: Image[]): Rendered[] {
  return images.flatMap((image) =>
    image.renders.flatMap((render) =>
      render.rendered === undefined ? [] : [render.rendered],
    ),
  );
}

function imagesOf(studies: Study[]): Image[] {
  return studies.flatMap((study) =>
    study.groups.flatMap((group) => group.images),
  );
}

function pendingOf(studies: Study[]): number {
  return studies
    .flatMap((study) => study.groups)
    .reduce((sum, group) => sum + group.pending, 0);
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const STYLE = `
:root { --bg: #f6f5f2; --card-bg: #ffffff; --text: #1d1d1f; --muted: #6b6b70; --line: #e2e0da; --accent: #3a5a8c; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #151517; --card-bg: #1f1f22; --text: #ececef; --muted: #9a9aa2; --line: #2e2e33; --accent: #8fb0e6; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, sans-serif; }
header, section { padding: 0 16px; max-width: 1400px; margin: 0 auto; }
header { padding-top: 24px; }
h1 { margin: 0 0 4px; font-size: 24px; }
h2, section > h3 { margin: 28px 0 12px; font-size: 19px; }
h2.category { margin: 44px 0 0; padding-bottom: 6px; font-size: 22px; border-bottom: 1px solid var(--line); }
h2 span, section > h3 span, header p { color: var(--muted); font-weight: normal; font-size: 14px; }
header p { margin: 0; }
a { color: var(--accent); text-decoration: none; }
nav { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
nav a { border: 1px solid var(--line); border-radius: 999px; padding: 2px 10px; font-size: 13px; }
.grid { --models: 1; --card: calc(var(--models) * ${DISPLAY_WIDTH}px + (var(--models) - 1) * ${RENDER_GAP}px + 2 * ${CARD_BORDER}px); display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(0, var(--card))); }
.card { margin: 0; background: var(--card-bg); border: ${CARD_BORDER}px solid var(--line); border-radius: 10px; overflow: hidden; color: inherit; }
.renders { display: grid; grid-auto-columns: 1fr; grid-auto-flow: column; gap: ${RENDER_GAP}px; }
.card img, .card .missing { display: block; width: 100%; aspect-ratio: ${IMAGE_WIDTH} / ${IMAGE_HEIGHT}; object-fit: cover; background: var(--line); }
.card .missing { display: grid; place-items: center; color: var(--muted); font-size: 12px; }
.renders span { display: block; padding: 6px 8px; color: var(--muted); font-size: 15px; font-weight: 600; text-align: center; }
.card h3 { margin: 10px 12px 4px; font-size: 15px; }
.category + .grid { margin-top: 16px; }
.groups { margin: 0 12px 12px; padding: 0; list-style: none; font-size: 13px; }
.links { display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 8px 0 0; padding: 0; list-style: none; font-size: 14px; }
.card p { margin: 0 12px 12px; color: var(--muted); font-size: 12px; }
footer { height: 32px; }
`;

function page(title: string, header: string, sections: string[]): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header>${header}</header>
${sections.join("\n")}
<footer></footer>
</body>
</html>
`;
}

function countLabel(groups: Group[]): string {
  const images = groups.reduce(
    (sum, group) => sum + renderedOf(group.images).length,
    0,
  );
  const pending = groups.reduce((sum, group) => sum + group.pending, 0);
  return `${images} images${pending === 0 ? "" : `, ${pending} pending`}`;
}

function cover(images: Image[]): string {
  const [rendered] = renderedOf(images);
  if (rendered === undefined) {
    return "";
  }
  return `<img src="${escapeHtml(rendered.file)}" alt="" loading="lazy">`;
}

function renderCell(image: Image, render: Render): string {
  const label = `<span>${escapeHtml(titleOf(render.model))}</span>`;
  if (render.censored) {
    return `<div><div class="missing">censored</div>${label}</div>`;
  }
  if (render.rendered === undefined) {
    return `<div><div class="missing">pending</div>${label}</div>`;
  }
  return `<div><img src="${escapeHtml(render.rendered.file)}" alt="${escapeHtml(`${image.name} by ${titleOf(render.model)}`)}" loading="lazy">${label}</div>`;
}

function promptsOf(image: Image): string {
  const rendered = image.renders.flatMap((render) =>
    render.rendered === undefined
      ? []
      : [{ model: render.model, prompt: render.rendered.prompt }],
  );
  const prompts = new Set(rendered.map((render) => render.prompt));
  if (prompts.size === 1) {
    return `<p>${escapeHtml(rendered[0].prompt)}</p>`;
  }
  return rendered
    .map(
      (render) =>
        `<p><b>${escapeHtml(titleOf(render.model))}</b> ${escapeHtml(render.prompt)}</p>`,
    )
    .join("");
}

function slugOf(title: string): string {
  return title.replaceAll(" ", "-");
}

export function indexPage(categories: Category[]): string {
  const sections = categories.map((category) => {
    const cards = category.studies.map((study) => {
      const href = escapeHtml(study.name);
      const groups = study.groups.map(
        (group) =>
          `<li><a href="${href}#${escapeHtml(group.name)}">${escapeHtml(titleOf(group.name))}</a></li>`,
      );
      return `<div class="card"><a href="${href}">${cover(study.groups.flatMap((group) => group.images))}</a><h3><a href="${href}">${escapeHtml(titleOf(study.name))}</a></h3><ul class="groups">${groups.join("")}</ul></div>`;
    });
    return `<section id="${escapeHtml(slugOf(category.name))}"><h2 class="category">${escapeHtml(category.name)}</h2><div class="grid">${cards.join("")}</div></section>`;
  });
  const nav = categories.map(
    (category) =>
      `<a href="#${escapeHtml(slugOf(category.name))}">${escapeHtml(category.name)}</a>`,
  );
  const links = LINKS.map(
    (link) =>
      `<li><a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a></li>`,
  );
  return page(
    TITLE,
    `<h1>${escapeHtml(TITLE)}</h1><p>${escapeHtml(TAGLINE)}</p><ul class="links">${links.join("")}</ul><nav>${nav.join("")}</nav>`,
    sections,
  );
}

export function studyPage(study: Study, models: string[]): string {
  const title = titleOf(study.name);
  const nav = study.groups.map(
    (group) =>
      `<a href="#${escapeHtml(group.name)}">${escapeHtml(titleOf(group.name))}</a>`,
  );
  const sections = study.groups.map((group) => {
    const cards = group.images.map(
      (image) =>
        `<figure class="card"><div class="renders">${image.renders.map((render) => renderCell(image, render)).join("")}</div><h3>${escapeHtml(image.name)}</h3>${promptsOf(image)}</figure>`,
    );
    return `<section id="${escapeHtml(group.name)}"><h2>${escapeHtml(titleOf(group.name))} <span>${countLabel([group])}</span></h2><div class="grid" style="--models: ${models.length}">${cards.join("")}</div></section>`;
  });
  return page(
    title,
    `<p><a href="./">All studies</a></p><h1>${escapeHtml(title)}</h1><p>${countLabel(study.groups)}</p><nav>${nav.join("")}</nav>`,
    sections,
  );
}

const run = promisify(execFile);

async function modifiedAt(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function readImageOptions(path: string): Promise<string | undefined> {
  if ((await modifiedAt(path)) === undefined) {
    return undefined;
  }
  return readFile(path, "utf8");
}

async function convert(
  image: Rendered,
  out: string,
  options: ImageOptions,
  force: boolean,
): Promise<boolean> {
  const target = join(out, image.file);
  const built = await modifiedAt(target);
  const rendered = await modifiedAt(image.source);
  if (
    !force &&
    built !== undefined &&
    rendered !== undefined &&
    built >= rendered
  ) {
    return false;
  }
  await mkdir(dirname(target), { recursive: true });
  await run("vips", [
    "thumbnail",
    image.source,
    `${target}[Q=${options.quality},strip]`,
    String(options.width),
    "--height",
    String(options.height),
  ]);
  return true;
}

async function eachLimited<T>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await work(item);
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));
}

async function removeStale(out: string, studies: Study[]): Promise<number> {
  const expected = new Set([
    ...renderedOf(imagesOf(studies)).map((image) => image.file),
    "index.html",
    ...studies.map((study) => `${study.name}.html`),
  ]);
  const entries = await readdir(out, { recursive: true, withFileTypes: true });
  const stale = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name.endsWith(".webp") || entry.name.endsWith(".html")),
    )
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => !expected.has(path.slice(out.length + 1)));
  await Promise.all(stale.map((path) => rm(path)));
  return stale.length;
}

function parseInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${name} must be an integer, got ${value}`);
  }
  return parsed;
}

export function parseImageOptions(args: string[]): ImageOptions {
  const { values } = parseArgs({
    args,
    options: {
      quality: { type: "string", default: "80" },
    },
  });
  const quality = parseInteger(values.quality, "quality");
  if (quality < 1 || quality > 100) {
    throw new Error(`quality must be 1 to 100, got ${quality}`);
  }
  return { width: IMAGE_WIDTH, height: IMAGE_HEIGHT, quality };
}

export async function main(): Promise<void> {
  const options = parseImageOptions(process.argv.slice(2));
  const dir = "study";
  const renders = "render";
  const out = "site";
  const models = await readModels(renders);
  const censored = await readCensored(dir);
  const categories = await readCategories({ renders, models, dir, censored });
  checkCensored(censored, categories);
  const studies = categories.flatMap((category) => category.studies);
  await mkdir(out, { recursive: true });
  const optionsPath = join(out, "images.json");
  const optionsJson = JSON.stringify(options);
  const force = (await readImageOptions(optionsPath)) !== optionsJson;
  const images = renderedOf(imagesOf(studies));
  let converted = 0;
  await eachLimited(images, availableParallelism(), async (image) => {
    if (await convert(image, out, options, force)) {
      converted += 1;
    }
  });
  await writeFile(optionsPath, optionsJson);
  const removed = await removeStale(out, studies);
  await writeFile(join(out, ".nojekyll"), "");
  await writeFile(join(out, "index.html"), indexPage(categories));
  await Promise.all(
    studies.map((study) =>
      writeFile(join(out, `${study.name}.html`), studyPage(study, models)),
    ),
  );
  const pending = pendingOf(studies);
  console.log(
    `wrote ${out} with ${studies.length} study pages and ${images.length} images from ${models.join(", ")} at ${options.width}x${options.height} quality ${options.quality}, converted ${converted}, removed ${removed}, ${pending} pending`,
  );
}
