#!/usr/bin/env python3
"""Translate a small queued batch with a direct Argos en -> target model."""
import json
import os
import re
import sys
import time

LANGUAGES = {
    "zh-CN": "zh", "ru": "ru", "es": "es", "pt": "pt", "ja": "ja",
    "ko": "ko", "de": "de", "fr": "fr", "vi": "vi",
}
PROTECTED = re.compile(
    r"https?://[^\s]+|`[^`]+`|(?:CONFIG|PACKAGE)_[A-Za-z0-9_]+|"
    r"(?:luci-app|luci-theme|kmod)-[A-Za-z0-9_.+-]+|(?:OpenWrt|LuCI)"
)


def protect(text):
    values = []

    def replace(match):
        values.append(match.group(0))
        return f"WEIGXHOLD{len(values) - 1}Z"

    return PROTECTED.sub(replace, text), values


def restore(text, values):
    for index, value in enumerate(values):
        pattern = re.compile(rf"WEIG\s*X\s*HOLD\s*{index}\s*Z", re.I)
        text, count = pattern.subn(value, text)
        if count != 1:
            return None
    return text


def main(queue_file, result_file):
    queue = json.load(open(queue_file, encoding="utf-8"))
    target = LANGUAGES.get(queue.get("language"))
    if not target:
        raise ValueError(f"Unsupported Argos language: {queue.get('language')}")

    import argostranslate.package
    import argostranslate.translate

    installed = argostranslate.translate.get_installed_languages()
    source_language = next((item for item in installed if item.code == "en"), None)
    target_language = next((item for item in installed if item.code == target), None)
    translation = source_language.get_translation(target_language) if source_language and target_language else None
    model_version = "installed"
    if not translation:
        print(f"Argos: downloading en -> {target} model...", flush=True)
        argostranslate.package.update_package_index()
        package = next((item for item in argostranslate.package.get_available_packages()
                        if item.from_code == "en" and item.to_code == target), None)
        if not package:
            raise RuntimeError(f"No direct Argos model exists for en -> {target}")
        model_version = str(package.package_version)
        argostranslate.package.install_from_path(package.download())
        installed = argostranslate.translate.get_installed_languages()
        source_language = next(item for item in installed if item.code == "en")
        target_language = next(item for item in installed if item.code == target)
        translation = source_language.get_translation(target_language)
    print(f"Argos: model en -> {target} ready ({model_version}).", flush=True)

    started = time.monotonic()
    limit = max(1, int(queue.get("timeBudgetSeconds") or 4500))
    translations, rejected = [], 0
    timed_out = False
    rows = queue.get("rows", [])
    total = len(rows)
    for index, row in enumerate(rows, 1):
        if time.monotonic() - started >= limit:
            timed_out = True
            break
        protected, values = protect(str(row.get("text") or ""))
        translated = restore(translation.translate(protected).strip(), values)
        original = str(row.get("text") or "").strip()
        if not translated or translated == original or len(translated) > len(original) * 4 + 20:
            rejected += 1
            continue
        translations.append({"id": row["id"], "text": translated})
        if index % 25 == 0 or index == total:
            elapsed = int(time.monotonic() - started)
            print(f"Argos: {index}/{total} ({index * 100 // max(1, total)}%) translated; {elapsed}s elapsed.", flush=True)
    json.dump({
        "provider": "argos", "model": f"en-{target}:{model_version}",
        "translations": translations, "rejected": rejected, "timedOut": timed_out,
    }, open(result_file, "w", encoding="utf-8"), ensure_ascii=False)


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        protected, values = protect("OpenWrt CONFIG_PACKAGE_demo uses https://example.test/x")
        assert restore(protected, values) == "OpenWrt CONFIG_PACKAGE_demo uses https://example.test/x"
    elif len(sys.argv) == 3:
        main(sys.argv[1], sys.argv[2])
    else:
        raise SystemExit("usage: translate-argos.py QUEUE RESULT")
