import { expect, test } from "bun:test";
import {
  batchImages,
  checkCategories,
  escapeHtml,
  groupNameOf,
  indexPage,
  parseImageOptions,
  pngText,
  promptOf,
  studyPage,
  type Category,
  type Study,
} from "./site";

function pngWithText(keyword: string, text: string): Uint8Array {
  const data = new TextEncoder().encode(`${keyword}\0${text}`);
  const chunk = new Uint8Array(12 + data.length);
  new DataView(chunk.buffer).setUint32(0, data.length);
  chunk.set(new TextEncoder().encode("tEXt"), 4);
  chunk.set(data, 8);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return new Uint8Array([...signature, ...chunk]);
}

test("pngText reads a text chunk by keyword", () => {
  const png = pngWithText("prompt", "hello");
  expect(pngText(png, "prompt")).toBe("hello");
});

test("promptOf reads the text encode input from the embedded workflow", () => {
  const workflow = JSON.stringify({
    "29": { class_type: "SaveImage", inputs: { filename_prefix: "x" } },
    "51": { class_type: "CLIPTextEncode", inputs: { text: "a red hat." } },
  });
  expect(promptOf(pngWithText("prompt", workflow))).toBe("a red hat.");
});

test("promptOf reads the Qwen-Image 2.1 prompt input", () => {
  const workflow = JSON.stringify({
    "461": { class_type: "SaveImageAdvanced", inputs: {} },
    "459:474": {
      class_type: "TextEncodeQwenImage21",
      inputs: { prompt: "a red hat." },
    },
  });
  expect(promptOf(pngWithText("prompt", workflow))).toBe("a red hat.");
});

test("escapeHtml escapes markup characters", () => {
  expect(escapeHtml(`<a href="x">&</a>`)).toBe(
    "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;",
  );
});

test("studyPage shows each group with its images and prompts", () => {
  const study: Study = {
    name: "hair-color",
    groups: [
      {
        name: "natural",
        images: [
          {
            name: "auburn",
            path: "hair-color/auburn.png",
            renders: [
              {
                model: "krea-2",
                censored: false,
                rendered: {
                  source: "render/krea-2/study/hair-color/auburn.png",
                  file: "krea-2/hair-color/auburn.webp",
                  prompt: "her hair is auburn.",
                },
              },
            ],
          },
        ],
        pending: 0,
      },
    ],
  };
  const html = studyPage(study, ["krea-2"]);
  expect(html).toContain("<title>hair color</title>");
  expect(html).toContain('<a href="./">All studies</a>');
  expect(html).toContain('<a href="#natural">natural</a>');
  expect(html).toContain(
    '<section id="natural"><h2>natural <span>1 images</span></h2>',
  );
  expect(html).toContain('src="krea-2/hair-color/auburn.webp"');
  expect(html).toContain("<span>krea 2</span>");
  expect(html).toContain("<p>her hair is auburn.</p>");
});

test("studyPage shows each model side by side with a pending slot", () => {
  const study: Study = {
    name: "hair-color",
    groups: [
      {
        name: "natural",
        images: [
          {
            name: "auburn",
            path: "hair-color/auburn.png",
            renders: [
              {
                model: "krea-2",
                censored: false,
                rendered: {
                  source: "render/krea-2/study/hair-color/auburn.png",
                  file: "krea-2/hair-color/auburn.webp",
                  prompt: "her hair is auburn.",
                },
              },
              {
                model: "qwen-image-2.1",
                rendered: undefined,
                censored: false,
              },
            ],
          },
        ],
        pending: 1,
      },
    ],
  };
  const html = studyPage(study, ["krea-2", "qwen-image-2.1"]);
  expect(html).toContain('<div class="grid" style="--models: 2">');
  expect(html).toContain(
    '<div><div class="missing">pending</div><span>qwen image 2.1</span></div>',
  );
  expect(html).toContain("<span>1 images, 1 pending</span>");
});

test("studyPage shows censored in place of a censored render", () => {
  const study: Study = {
    name: "outfit",
    groups: [
      {
        name: "west-africa",
        images: [
          {
            name: "kaba and slit",
            path: "outfit/kaba-and-slit.png",
            renders: [
              { model: "krea-2", rendered: undefined, censored: true },
              {
                model: "qwen-image-2.1",
                censored: false,
                rendered: {
                  source:
                    "render/qwen-image-2.1/study/outfit/kaba-and-slit.png",
                  file: "qwen-image-2.1/outfit/kaba-and-slit.webp",
                  prompt: "she wears a kaba and slit.",
                },
              },
            ],
          },
        ],
        pending: 0,
      },
    ],
  };
  const html = studyPage(study, ["krea-2", "qwen-image-2.1"]);
  expect(html).toContain(
    '<div><div class="missing">censored</div><span>krea 2</span></div>',
  );
  expect(html).toContain("<span>1 images</span>");
});

test("studyPage labels the prompt of each model when they differ", () => {
  const study: Study = {
    name: "hair-color",
    groups: [
      {
        name: "natural",
        images: [
          {
            name: "auburn",
            path: "hair-color/auburn.png",
            renders: [
              {
                model: "krea-2",
                censored: false,
                rendered: {
                  source: "render/krea-2/study/hair-color/auburn.png",
                  file: "krea-2/hair-color/auburn.webp",
                  prompt: "her hair is auburn.",
                },
              },
              {
                model: "qwen-image-2.1",
                censored: false,
                rendered: {
                  source: "render/qwen-image-2.1/study/hair-color/auburn.png",
                  file: "qwen-image-2.1/hair-color/auburn.webp",
                  prompt: "her hair is deep auburn.",
                },
              },
            ],
          },
        ],
        pending: 0,
      },
    ],
  };
  const html = studyPage(study, ["krea-2", "qwen-image-2.1"]);
  expect(html).toContain(
    "<p><b>krea 2</b> her hair is auburn.</p><p><b>qwen image 2.1</b> her hair is deep auburn.</p>",
  );
});

test("indexPage shows each study with its first image and its groups", () => {
  const categories: Category[] = [
    {
      name: "physical features",
      studies: [
        {
          name: "hair-color",
          groups: [
            {
              name: "natural",
              images: [
                {
                  name: "auburn",
                  path: "hair-color/auburn.png",
                  renders: [
                    {
                      model: "krea-2",
                      censored: false,
                      rendered: {
                        source: "render/krea-2/study/hair-color/auburn.png",
                        file: "krea-2/hair-color/auburn.webp",
                        prompt: "her hair is auburn.",
                      },
                    },
                  ],
                },
              ],
              pending: 0,
            },
            { name: "dyed", images: [], pending: 2 },
          ],
        },
      ],
    },
    {
      name: "accessibility",
      studies: [
        {
          name: "accessibility",
          groups: [{ name: "mobility", images: [], pending: 1 }],
        },
      ],
    },
  ];
  const html = indexPage(categories);
  expect(html).toContain("<title>Krea-2 — Qwen-Image-2.1 study</title>");
  expect(html).toContain(
    "<h1>Krea-2 — Qwen-Image-2.1 study</h1><p>Identical prompts, vanilla ComfyUI workflows</p>",
  );
  expect(html).toContain(
    '<nav><a href="#physical-features">physical features</a><a href="#accessibility">accessibility</a></nav>',
  );
  expect(html).toContain(
    '<div class="card"><a href="hair-color"><img src="krea-2/hair-color/auburn.webp" alt="" loading="lazy"></a><h3><a href="hair-color">hair color</a></h3><ul class="groups"><li><a href="hair-color#natural">natural</a></li><li><a href="hair-color#dyed">dyed</a></li></ul></div>',
  );
  expect(html.indexOf("physical features</h2>")).toBeLessThan(
    html.indexOf("accessibility</h2>"),
  );
});

test("checkCategories accepts every study listed once", () => {
  expect(() =>
    checkCategories(
      [
        { name: "physical features", studies: ["age", "height"] },
        { name: "accessibility", studies: ["accessibility"] },
      ],
      ["accessibility", "age", "height"],
    ),
  ).not.toThrow();
});

test("groupNameOf drops the order prefix", () => {
  expect(groupNameOf("03-body-art.md")).toBe("body-art");
});

test("parseImageOptions defaults to 608x800 at quality 80", () => {
  expect(parseImageOptions([])).toEqual({
    width: 608,
    height: 800,
    quality: 80,
  });
});

test("parseImageOptions reads quality", () => {
  expect(parseImageOptions(["--quality", "90"])).toEqual({
    width: 608,
    height: 800,
    quality: 90,
  });
});

test("batchImages lists the image headings of a batch", () => {
  const markdown =
    "---\nwidth: 736\n---\n\n# age/20.png\n\n- a woman aged 20\n\n# age/25.png\n\n- a woman aged 25\n";
  expect(batchImages(markdown)).toEqual(["age/20.png", "age/25.png"]);
});
