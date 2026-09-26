/* eslint-disable effecttsgo/async-function, effecttsgo/global-console, effecttsgo/global-fetch, effecttsgo/global-timers, effecttsgo/new-promise -- The browser client is deliberately plain DOM and promise code; Effect is used only for the shared API schema and generated client. */
import type { PracticeItem, SessionView } from "../src/domain/model.ts";
import * as api from "./api.ts";

// ---------------------------------------------------------------------------
// Tiny DOM helpers.
// ---------------------------------------------------------------------------

type Child = Node | string | null | undefined | false;

const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  ...children: ReadonlyArray<Child>
): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  const { class: className, ...rest } = props;
  if (className !== undefined) {
    el.className = className;
  }
  Object.assign(el, rest);
  for (const child of children) {
    if (child === null || child === undefined || child === false) {
      continue;
    }
    el.append(child);
  }
  return el;
};

const app = document.getElementById("app")!;

/** Bumped on every screen change so stale timers and callbacks stop. */
let screen = 0;

const show = (...children: ReadonlyArray<Child>): number => {
  screen += 1;
  app.replaceChildren(
    ...children.filter(
      (c): c is Node | string => c !== null && c !== undefined && c !== false,
    ),
  );
  return screen;
};

const sleep = async (ms: number) => new Promise((r) => setTimeout(r, ms));

const knownErrors: Record<string, string> = {
  NoActiveSession: "There is no active session.",
  NotRetryable: "This step can't be retried. Start over with a new recording.",
  SessionAlreadyExists: "A session already exists.",
};

const errorText = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const known = knownErrors[String(error._tag)];
    if (known !== undefined) {
      return known;
    }
  }
  return error instanceof Error && error.message !== ""
    ? error.message
    : "Something went wrong.";
};

// ---------------------------------------------------------------------------
// Session routing.
// ---------------------------------------------------------------------------

let practice: Practice | undefined;

const refresh = async (): Promise<void> => {
  try {
    render(await api.currentSession());
  } catch (error) {
    renderConnectionError(error);
  }
};

const render = (view: SessionView): void => {
  if (view._tag !== "Ready") {
    practice?.dispose();
    practice = undefined;
  }
  switch (view._tag) {
    case "NoSession": {
      renderUpload();
      return;
    }
    case "Preparing": {
      renderPreparing(view.stage);
      return;
    }
    case "Failed": {
      renderFailed(view.failure);
      return;
    }
    case "Ready":
      if (practice === undefined || !practice.isMounted()) {
        practice?.dispose();
        practice = new Practice(view);
      } else {
        practice.updateSession(view);
      }
      return;
  }
};

const startOver = async (): Promise<void> => {
  if (
    !confirm(
      "Start over with a new recording? Your current session will be deleted.",
    )
  ) {
    return;
  }
  try {
    await api.resetSession();
  } catch (error) {
    alert(errorText(error));
  }
  await refresh();
};

const renderConnectionError = (error: unknown): void => {
  show(
    h(
      "section",
      { class: "card center" },
      h("h1", {}, "Can't reach the server"),
      h("p", { class: "muted" }, errorText(error)),
      h(
        "button",
        { class: "btn primary", onclick: () => void refresh() },
        "Try again",
      ),
    ),
  );
};

// ---------------------------------------------------------------------------
// Upload.
// ---------------------------------------------------------------------------

const renderUpload = (): void => {
  const input = h("input", {
    accept: "audio/*",
    class: "file",
    id: "recording",
    type: "file",
  });
  const fileLabel = h("span", { class: "file-name" }, "Choose a recording");
  const pick = h(
    "label",
    { class: "btn picker", htmlFor: "recording" },
    fileLabel,
  );
  const button = h(
    "button",
    { class: "btn primary", disabled: true },
    "Upload",
  );
  const status = h("p", { class: "status", role: "status" });
  const progress = h("progress", { hidden: true, max: 1, value: 0 });

  input.addEventListener("change", () => {
    const file = input.files?.[0];
    fileLabel.textContent = file?.name ?? "Choose a recording";
    button.disabled = file === undefined;
    status.textContent = "";
    status.classList.remove("error");
  });

  const upload = async (): Promise<void> => {
    const file = input.files?.[0];
    if (file === undefined) {
      return;
    }
    button.disabled = true;
    input.disabled = true;
    pick.classList.add("disabled");
    progress.hidden = false;
    progress.removeAttribute("value");
    status.classList.remove("error");
    status.textContent = "Uploading…";
    try {
      await api.uploadRecording(file, (fraction) => {
        progress.value = fraction;
        status.textContent =
          fraction >= 1
            ? "Processing upload…"
            : `Uploading… ${Math.round(fraction * 100)}%`;
      });
      await refresh();
    } catch (error) {
      if (error instanceof api.UploadError && error.status === 409) {
        // A session appeared meanwhile (another tab?); show it.
        status.classList.add("error");
        status.textContent = errorText(error);
        await sleep(1500);
        return refresh();
      }
      progress.hidden = true;
      status.classList.add("error");
      status.textContent = errorText(error);
      button.disabled = false;
      input.disabled = false;
      pick.classList.remove("disabled");
    }
  };
  button.addEventListener("click", () => void upload());

  show(
    h(
      "section",
      { class: "card" },
      h("h1", {}, "Crosstalk practice"),
      h(
        "p",
        { class: "muted" },
        "Upload a recording of a crosstalk conversation. You'll get an endless stream of new Finnish sentences built from it to practice listening.",
      ),
      input,
      pick,
      button,
      progress,
      status,
      h("p", { class: "note" }, "Recordings up to about 30 minutes work best."),
    ),
  );
};

// ---------------------------------------------------------------------------
// Preparing / Failed.
// ---------------------------------------------------------------------------

const stageText: Record<string, string> = {
  analyzing: "Analyzing the conversation…",
  generating: "Generating the first sentences…",
  transcribing: "Transcribing the recording…",
};

const renderPreparing = (stage: string): void => {
  const token = show(
    h(
      "section",
      { class: "card center" },
      h("div", { ariaHidden: "true", class: "spinner" }),
      h("h1", {}, stageText[stage] ?? "Preparing…"),
      h(
        "p",
        { class: "muted" },
        "This can take a few minutes for long recordings.",
      ),
      h(
        "button",
        { class: "link", onclick: () => void startOver() },
        "Start over with a new recording",
      ),
    ),
  );
  void sleep(3000).then(() => {
    if (token === screen) {
      void refresh();
    }
  });
};

const renderFailed = (failure: {
  readonly message: string;
  readonly retryable: boolean;
}): void => {
  const status = h("p", { class: "status error", role: "status" });
  const retry = failure.retryable
    ? h("button", { class: "btn primary" }, "Retry")
    : null;
  const onRetry = async (button: HTMLButtonElement): Promise<void> => {
    button.disabled = true;
    try {
      render(await api.retrySession());
    } catch (error) {
      status.textContent = errorText(error);
      button.disabled = false;
    }
  };
  retry?.addEventListener("click", () => void onRetry(retry));
  show(
    h(
      "section",
      { class: "card center" },
      h("h1", {}, "Preparation failed"),
      h("p", {}, failure.message),
      retry,
      h(
        "button",
        { class: "btn", onclick: () => void startOver() },
        "Start over",
      ),
      status,
    ),
  );
};

// ---------------------------------------------------------------------------
// Practice.
// ---------------------------------------------------------------------------

type ReadyView = Extract<SessionView, { readonly _tag: "Ready" }>;

class Practice {
  private readonly token: number;
  private readonly audio = new Audio();
  private queue: Array<PracticeItem> = [];
  /** Sentences answered locally, so a stale `upcoming` never shows them again. */
  private readonly answered = new Set<string>();
  /** Object URLs of prefetched audio, keyed by sentence id. */
  private readonly audioUrls = new Map<string, Promise<string>>();
  private plays = 0;
  private revealed = false;
  private fetching = false;
  private answeredCount: number;
  private understoodCount: number;

  private readonly stats = h("p", { class: "stats" });
  private readonly playButton = h("button", { class: "play" });
  private readonly translation = h("p", { class: "translation", hidden: true });
  private readonly revealButton = h(
    "button",
    { class: "btn" },
    "Show translation",
  );
  private readonly understoodButton = h(
    "button",
    { class: "btn yes" },
    "Understood",
  );
  private readonly notUnderstoodButton = h(
    "button",
    { class: "btn no" },
    "Didn't understand",
  );
  private readonly hint = h("p", { class: "hint", role: "status" });
  private readonly stage = h("div", { class: "stage" });
  private readonly waiting = h(
    "div",
    { class: "waiting", hidden: true },
    h("div", { ariaHidden: "true", class: "spinner" }),
    h("p", {}, "Preparing more sentences…"),
  );
  private readonly about = h("details", { class: "about" });

  public constructor(view: ReadyView) {
    this.answeredCount = view.stats.answered;
    this.understoodCount = view.stats.understood;
    this.audio.preload = "auto";

    this.playButton.addEventListener("click", () => void this.play());
    this.revealButton.addEventListener("click", () => {
      this.revealed = true;
      this.translation.hidden = false;
      this.revealButton.hidden = true;
    });
    this.understoodButton.addEventListener("click", () => this.answer(true));
    this.notUnderstoodButton.addEventListener("click", () =>
      this.answer(false),
    );
    this.audio.addEventListener("playing", () =>
      this.playButton.classList.add("playing"),
    );
    for (const ev of ["pause", "ended", "error"]) {
      this.audio.addEventListener(ev, () =>
        this.playButton.classList.remove("playing"),
      );
    }

    this.stage.append(
      this.playButton,
      this.hint,
      this.revealButton,
      this.translation,
      h(
        "div",
        { class: "answers" },
        this.notUnderstoodButton,
        this.understoodButton,
      ),
    );

    this.token = show(
      h(
        "header",
        { class: "bar" },
        this.stats,
        h(
          "button",
          { class: "link", onclick: () => void startOver() },
          "Start over with a new recording",
        ),
      ),
      h("section", { class: "practice" }, this.stage, this.waiting),
      this.about,
    );
    this.updateSession(view);
    this.renderStats();
    this.showCurrent(false);
    void this.fill();
  }

  public isMounted(): boolean {
    return this.token === screen;
  }

  public dispose(): void {
    this.audio.pause();
    this.audio.removeAttribute("src");
    for (const url of this.audioUrls.values()) {
      void url.then(URL.revokeObjectURL, () => {});
    }
    this.audioUrls.clear();
  }

  public updateSession(view: ReadyView): void {
    // Server stats may lag behind in-flight responses; never go backwards.
    this.answeredCount = Math.max(this.answeredCount, view.stats.answered);
    this.understoodCount = Math.max(
      this.understoodCount,
      view.stats.understood,
    );
    this.renderStats();
    const topics = view.topics.length > 0 ? view.topics.join(" · ") : "";
    this.about.replaceChildren(
      h(
        "summary",
        {},
        topics !== "" ? `Topics: ${topics}` : "About this session",
      ),
      h("p", {}, view.summary),
      h("p", { class: "muted" }, view.fileName),
    );
  }

  private renderStats(): void {
    this.stats.textContent = `${this.answeredCount} answered · ${this.understoodCount} understood`;
  }

  private get current(): PracticeItem | undefined {
    return this.queue[0];
  }

  /** Keeps the local queue topped up; polls while the server has nothing ready. */
  private async fill(): Promise<void> {
    if (this.fetching) {
      return;
    }
    this.fetching = true;
    try {
      while (this.isMounted() && this.queue.length < 2) {
        let items: ReadonlyArray<PracticeItem>;
        try {
          items = await api.upcoming();
        } catch {
          // Most likely the session went away (reset elsewhere); re-route.
          if (this.isMounted()) {
            void refresh();
          }
          return;
        }
        if (!this.isMounted()) {
          return;
        }
        const known = new Set(this.queue.map((i) => i.sentenceId as string));
        const wasEmpty = this.queue.length === 0;
        for (const item of items) {
          if (
            !known.has(item.sentenceId) &&
            !this.answered.has(item.sentenceId)
          ) {
            this.queue.push(item);
          }
        }
        this.preload();
        if (wasEmpty && this.queue.length > 0) {
          this.showCurrent(true);
        }
        if (this.queue.length === 0) {
          await sleep(2000);
        } else {
          break;
        }
      }
    } finally {
      this.fetching = false;
    }
  }

  private preload(): void {
    for (const item of this.queue.slice(0, 2)) {
      if (this.audioUrls.has(item.sentenceId)) {
        continue;
      }
      const url = fetch(item.audioUrl)
        .then(async (res) => {
          if (!res.ok) {
            throw new Error(`audio HTTP ${res.status}`);
          }
          return res.blob();
        })
        .then((blob) => URL.createObjectURL(blob));
      url.catch(() => this.audioUrls.delete(item.sentenceId));
      this.audioUrls.set(item.sentenceId, url);
    }
  }

  private showCurrent(autoplay: boolean): void {
    const item = this.current;
    this.plays = 0;
    this.revealed = false;
    this.audio.pause();
    this.stage.hidden = item === undefined;
    this.waiting.hidden = item !== undefined;
    if (item === undefined) {
      return;
    }
    this.playButton.textContent = "▶ Play";
    this.playButton.setAttribute("aria-label", "Play sentence");
    this.translation.textContent = item.english;
    this.translation.hidden = true;
    this.revealButton.hidden = false;
    this.hint.textContent = autoplay ? "" : "Tap to listen";
    if (autoplay) {
      void this.play(true);
    }
  }

  private async play(auto = false): Promise<void> {
    const item = this.current;
    if (item === undefined) {
      return;
    }
    let src = item.audioUrl;
    const cached = this.audioUrls.get(item.sentenceId);
    if (cached !== undefined) {
      try {
        src = await cached;
      } catch {
        // Fall back to streaming from the server.
      }
    }
    if (this.current !== item || !this.isMounted()) {
      return;
    }
    if (this.audio.src !== src) {
      this.audio.src = src;
    }
    this.audio.currentTime = 0;
    try {
      await this.audio.play();
    } catch (error) {
      if (this.current !== item) {
        return;
      }
      this.hint.textContent =
        auto &&
        error instanceof DOMException &&
        error.name === "NotAllowedError"
          ? "Tap to listen"
          : "Couldn't play the audio. Tap to try again.";
      return;
    }
    if (this.current !== item) {
      return;
    }
    this.plays += 1;
    this.hint.textContent = "";
    this.playButton.textContent = "↻ Replay";
    this.playButton.setAttribute("aria-label", "Replay sentence");
  }

  private answer(understood: boolean): void {
    const item = this.current;
    if (item === undefined) {
      return;
    }
    const payload = {
      replayCount: Math.max(0, this.plays - 1),
      translationRevealed: this.revealed,
      understood,
    };
    this.answered.add(item.sentenceId);
    this.queue.shift();
    this.answeredCount += 1;
    if (understood) {
      this.understoodCount += 1;
    }
    this.renderStats();

    const url = this.audioUrls.get(item.sentenceId);
    this.audioUrls.delete(item.sentenceId);

    this.showCurrent(true);
    this.preload();
    void this.fill();

    void api.respond(item.sentenceId, payload).then(
      () => undefined,
      (error: unknown) => {
        // Answers are fire-and-forget; surface failures without blocking practice.
        console.error("Failed to record response", error);
        if (this.isMounted()) {
          this.hint.textContent = "Couldn't save the last answer.";
        }
      },
    );
    // Revoke after the element has moved on to another source.
    void url?.then(
      (u) => setTimeout(() => URL.revokeObjectURL(u), 1000),
      () => {},
    );
  }
}

void refresh();
