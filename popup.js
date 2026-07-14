document.getElementById("copyTranscript").addEventListener("click", async () => {
  const button = document.getElementById("copyTranscript");
  button.disabled = true;
  button.textContent = "Extracting...";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.id || !tab.url || !tab.url.includes("youtube.com/watch")) {
      throw new Error("Please open a specific YouTube video page.");
    }

    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractTranscriptFromYouTubeUi
    });

    const response = result && result.result;

    if (!response) {
      throw new Error("Could not read a response from the YouTube tab.");
    }

    if (response.error) {
      throw new Error(response.error);
    }

    await navigator.clipboard.writeText(response.transcript);
    alert("Transcript copied!");
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Copy Transcript";
  }
});

// Everything below is injected into the active YouTube tab by chrome.scripting.
async function extractTranscriptFromYouTubeUi() {
  const SHOW_TRANSCRIPT_ERROR =
    "Could not find the Show Transcript button on the page.";

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const normalize = (text) => String(text || "").replace(/\s+/g, " ").trim();

  const isVisible = (element) => {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();

    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity) !== 0 &&
      rect.width > 0 &&
      rect.height > 0
    );
  };

  const clickElement = (element) => {
    element.scrollIntoView({ block: "center", inline: "center" });
    element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    element.click();
  };

  const findByXPath = (xpath) => {
    const snapshot = document.evaluate(
      xpath,
      document,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null
    );

    for (let index = 0; index < snapshot.snapshotLength; index += 1) {
      const element = snapshot.snapshotItem(index);
      if (isVisible(element)) {
        return element;
      }
    }

    return null;
  };

  const findClickableByText = (textToFind) => {
    const targetText = textToFind.toLowerCase();
    const candidates = Array.from(
      document.querySelectorAll(
        "button, tp-yt-paper-button, yt-button-shape button, a, [role='button']"
      )
    );

    return candidates.find((element) => {
      const text = normalize(element.innerText || element.textContent);
      return isVisible(element) && text.toLowerCase().includes(targetText);
    });
  };

  const expandDescription = async () => {
    const selectors = [
      "ytd-watch-metadata tp-yt-paper-button#expand",
      "ytd-watch-metadata #description-inline-expander #expand",
      "ytd-watch-metadata ytd-text-inline-expander #expand",
      "ytd-watch-metadata #expand",
      "#description-inline-expander #expand",
      "ytd-text-inline-expander #expand"
    ];

    const selectorMatch = selectors
      .map((selector) => document.querySelector(selector))
      .find(isVisible);

    const textMatch =
      selectorMatch ||
      findByXPath(
        "//*[self::button or self::tp-yt-paper-button or @role='button'][contains(translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'more')]"
      ) ||
      findClickableByText("more");

    if (textMatch) {
      clickElement(textMatch);
      await wait(400);
    }
  };

  const openTranscript = async () => {
    const transcriptButton =
      findByXPath(
        "//*[self::button or self::tp-yt-paper-button or @role='button'][contains(translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'show transcript')]"
      ) || findClickableByText("Show transcript");

    if (!transcriptButton) {
      return false;
    }

    clickElement(transcriptButton);
    await wait(200);
    return true;
  };

  const getTranscriptPanel = () =>
    document.querySelector(
      "ytd-engagement-panel-section-list-renderer[target-id='engagement-panel-searchable-transcript']"
    ) ||
    document.querySelector("ytd-transcript-renderer") ||
    document.querySelector("ytd-transcript-search-panel-renderer") ||
    document;

  const selectEnglishTranscriptIfAvailable = async () => {
    const panel = getTranscriptPanel();
    const languageButton = Array.from(
      panel.querySelectorAll(
        "ytd-transcript-footer-renderer button, ytd-transcript-footer-renderer [role='button'], yt-dropdown-menu button, yt-dropdown-menu [role='button']"
      )
    ).find(isVisible);

    if (!languageButton) {
      return;
    }

    if (normalize(languageButton.textContent).toLowerCase().includes("english")) {
      return;
    }

    clickElement(languageButton);
    await wait(300);

    const englishOption = Array.from(
      document.querySelectorAll(
        "tp-yt-paper-listbox tp-yt-paper-item, ytd-menu-service-item-renderer, yt-formatted-string, button, [role='option'], [role='menuitem']"
      )
    ).find((element) => {
      const text = normalize(element.textContent).toLowerCase();
      return isVisible(element) && text.includes("english");
    });

    if (englishOption) {
      clickElement(englishOption);
      await wait(800);
    }
  };

  const waitForTranscriptSegments = async () => {
    const startedAt = Date.now();

    while (Date.now() - startedAt < 5000) {
      const segments = Array.from(
        getTranscriptPanel().querySelectorAll("ytd-transcript-segment-renderer")
      ).filter(isVisible);

      if (segments.length > 0) {
        return segments;
      }

      await wait(200);
    }

    return [];
  };

  const extractSegmentText = (segment) => {
    const textElement =
      segment.querySelector("yt-formatted-string.segment-text") ||
      segment.querySelector(".segment-text") ||
      segment.querySelector("[id='segment-text']") ||
      segment.querySelector("yt-formatted-string:not(.segment-timestamp)");

    if (textElement) {
      return normalize(textElement.textContent);
    }

    const clone = segment.cloneNode(true);
    clone
      .querySelectorAll(
        ".segment-timestamp, [id='timestamp'], [class*='timestamp'], .timestamp"
      )
      .forEach((timestamp) => timestamp.remove());

    return normalize(clone.textContent);
  };

  try {
    await expandDescription();

    const openedTranscript = await openTranscript();
    if (!openedTranscript) {
      return { error: SHOW_TRANSCRIPT_ERROR };
    }

    await selectEnglishTranscriptIfAvailable();

    const segments = await waitForTranscriptSegments();
    if (segments.length === 0) {
      return {
        error:
          "The transcript panel opened, but no transcript text appeared within 5 seconds."
      };
    }

    const transcript = segments
      .map(extractSegmentText)
      .filter(Boolean)
      .join(" ")
      .replace(/\n+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!transcript) {
      return { error: "Could not extract readable transcript text." };
    }

    return { transcript };
  } catch (error) {
    return { error: error.message || "Could not extract the transcript." };
  }
}