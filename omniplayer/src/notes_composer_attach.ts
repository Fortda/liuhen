/**
 * Composer 加号：附图片（发给 AI / 流式笔记排版）。
 */
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  hideFloat,
  placeFloatInViewport,
  revealFloat,
} from "./omni_float";

export type ComposerImage = {
  id: string;
  path: string;
  previewUrl: string;
};

let images: ComposerImage[] = [];
let addPopoverOpen = false;
let addOutsideHandler: ((e: MouseEvent) => void) | null = null;

const IMAGE_EXT = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

export function getComposerImagePaths(): string[] {
  return images.map((i) => i.path);
}

export function clearComposerImages() {
  images = [];
  renderComposerAttachments();
}

function renderComposerAttachments() {
  const host = $("notes-composer-attachments");
  if (!host) return;
  host.innerHTML = "";
  if (!images.length) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  for (const img of images) {
    const wrap = document.createElement("div");
    wrap.className = "notes-composer-attach-item";
    const thumb = document.createElement("img");
    thumb.src = img.previewUrl;
    thumb.alt = "附件图片";
    thumb.loading = "lazy";
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "notes-composer-attach-remove";
    rm.setAttribute("aria-label", "移除图片");
    rm.textContent = "×";
    rm.addEventListener("click", () => {
      images = images.filter((x) => x.id !== img.id);
      renderComposerAttachments();
    });
    wrap.append(thumb, rm);
    host.appendChild(wrap);
  }
}

async function addImagesFromPaths(paths: string[]) {
  for (const path of paths) {
    if (!path || images.some((i) => i.path === path)) continue;
    try {
      const previewUrl = await invoke<string>("read_file_as_data_url", {
        filePath: path,
      });
      images.push({
        id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        path,
        previewUrl,
      });
    } catch (e) {
      console.error(e);
    }
  }
  renderComposerAttachments();
}

async function pickImages() {
  const selected = await open({
    multiple: true,
    filters: [{ name: "图片", extensions: IMAGE_EXT }],
  });
  if (!selected) return;
  const paths = Array.isArray(selected) ? selected : [selected];
  await addImagesFromPaths(
    paths.filter((p): p is string => typeof p === "string")
  );
}

function closeAddPopover() {
  addPopoverOpen = false;
  $("notes-composer-add-btn")?.setAttribute("aria-expanded", "false");
  hideFloat($("notes-composer-add-popover"));
  if (addOutsideHandler) {
    document.removeEventListener("click", addOutsideHandler, true);
    addOutsideHandler = null;
  }
}

function openAddPopover(anchor: HTMLElement) {
  let pop = $("notes-composer-add-popover");
  if (!pop) {
    pop = document.createElement("div");
    pop.id = "notes-composer-add-popover";
    pop.className = "notes-composer-add-popover omni-float hidden";
    pop.setAttribute("role", "menu");
    pop.innerHTML = `<button type="button" class="notes-composer-add-menu-item" data-action="image">图片</button>`;
    document.body.appendChild(pop);
    pop.querySelector("[data-action='image']")?.addEventListener("click", () => {
      closeAddPopover();
      void pickImages();
    });
  }
  revealFloat(pop);
  placeFloatInViewport(pop, anchor.getBoundingClientRect(), "above", 140);
  addPopoverOpen = true;
  anchor.setAttribute("aria-expanded", "true");
  if (addOutsideHandler) {
    document.removeEventListener("click", addOutsideHandler, true);
  }
  addOutsideHandler = (e: MouseEvent) => {
    const t = e.target as Element | null;
    if (
      t?.closest?.("#notes-composer-add-popover") ||
      t?.closest?.("#notes-composer-add-btn")
    ) {
      return;
    }
    closeAddPopover();
  };
  window.setTimeout(() => {
    document.addEventListener("click", addOutsideHandler!, true);
  }, 0);
}

export function initComposerAttachUi() {
  const btn = $("notes-composer-add-btn");
  if (!btn) return;
  renderComposerAttachments();
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (addPopoverOpen) closeAddPopover();
    else openAddPopover(btn);
  });
}

export function closeComposerAttachPopover() {
  closeAddPopover();
}

/** 卡片内展示用户图片（异步加载 data URL）。 */
export async function appendCardUserImages(
  host: HTMLElement,
  paths: string[] | undefined
) {
  if (!paths?.length) return;
  const row = document.createElement("div");
  row.className = "notes-card-user-images";
  host.appendChild(row);
  for (const path of paths) {
    const img = document.createElement("img");
    img.className = "notes-card-user-image";
    img.alt = "用户图片";
    img.loading = "lazy";
    row.appendChild(img);
    try {
      img.src = await invoke<string>("read_file_as_data_url", { filePath: path });
    } catch {
      img.alt = "图片加载失败";
    }
  }
}
