"""Run a small, reviewed allowlist of local checks; never publish or deploy.

Use --list to inspect the selected scope and side effects without creating files.
This is an orchestrator, not an OS sandbox or a claim of complete project coverage.
"""

from __future__ import annotations

import argparse
from collections import Counter
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import time
import uuid


ROOT = Path(__file__).resolve().parents[1]
STATES = ("PASS", "FAIL", "SKIP", "BLOCKED")
KNOWN_BASELINE_LIMITS = (
    "nai_default_tags_community: requires the unmerged community-codex.js branch; missing modules remain BLOCKED. Main normalization runs in ci.",
    "search_benchmark: current implementation measurements require private local data; public synthetic semantics run in ci. No improvement is inferred.",
    "search_legacy_comparison: legacy/current recall sets must match before timing; semantic differences remain BLOCKED, never a successful performance comparison.",
)
LIMITATIONS = (
    "Only the named checks ran. This is not a full regression, browser/device acceptance, production audit or performance improvement claim.",
    "Node assertion scripts report script completion only; their internal assertion/case counts are unknown.",
    "The allowlist was reviewed for local fixtures. Environment cleaning is not an OS filesystem/network sandbox; re-review scripts and imports when changed.",
    "Memory/fake bindings and SQLite do not validate Cloudflare concurrency, limits, credentials, deployed configuration or monitoring.",
    "Reports may contain local paths and test output. Baseline reports also identify private-data paths; keep them out of public artifacts.",
)


@dataclass(frozen=True)
class Check:
    id: str
    runtime: str
    args: tuple[str, ...]
    inputs: tuple[str, ...]
    marker: str = ""
    parser: str = "marker"
    timeout: float = 90
    required: bool = True
    platform: str = "any"
    sqlite: bool = False
    private_data: bool = False
    read: str = "Listed source files and in-memory public fixtures"
    write: str = "No business files; runner writes report and logs"
    network: str = "None in reviewed test paths; not enforced by an OS sandbox"
    credentials: str = "None; child does not inherit credentials or proxy configuration"
    blocked_marker: str = ""


# This is the single execution allowlist. Never discover test_* or maintenance tools.
R2_RELEASE_INPUTS = (
    "tools/publish_data_r2.py", "tools/publish_data_r2_v2.py", "tools/r2_data_protocol.py",
    "tools/r2_data_snapshot.py", "tools/r2_local_client.py", "tools/sync_r2.py", "tools/r2_http_pool.py",
    "tools/r2_cas_experiment/store.py", "tools/r2_cas_experiment/publisher.py", "tools/r2_cas_experiment/protocol.py",
)
R2_READER_INPUTS = ("site/assets/data-release.js", "functions/_atlas_data.js")
MODERATION_INPUTS = (
    "tools/memory-r2-test-harness.mjs", "tools/sqlite-d1-test-harness.mjs",
    "functions/_record-store.js", "functions/_record-index.js", "functions/_lib.js", "functions/_feedback.js", "functions/_feedback-list.js",
    "functions/_submission_guards.js", "functions/_engagements.js", "functions/_params_core.js",
    "functions/api/submit.js", "functions/api/feedback.js", "functions/api/feedback-public.js",
    "functions/api/community.js", "functions/api/community-likes/[id].js",
    "functions/api/admin/community/[[path]].js", "functions/api/admin/feedback.js",
    "functions/api/admin/feedback-decide.js", "functions/api/admin/feedback-delete.js",
    "migrations/0001_community_likes.sql", "migrations/0002_engagement_tombstones.sql",
    "migrations/0003_favorites_pickup.sql", "migrations/0004_submission_guards.sql",
    "migrations/0005_site_metrics.sql",
)
CHECKS = (
    Check("stable_entry_ids", "python", ("-B", "-m", "unittest", "tools.test_edit_server.StableEntryIdTest"),
          ("tools/test_edit_server.py", "tools/edit_server.py", "tools/local_launcher.py"), parser="unittest",
          write="Synthetic temporary books, ID high-water metadata and rollback backups only"),
    Check("edit_server", "python", ("-B", "-m", "unittest", "tools.test_edit_server"),
          ("tools/test_edit_server.py", "tools/edit_server.py", "tools/local_launcher.py"), parser="unittest", timeout=120,
          write="Synthetic temporary books, images, backups and local editor fixtures only",
          network="Ephemeral loopback HTTP smoke fixtures only; no external service requests"),
    Check("params_inflate_budget", "node", ("tools/test_params_inflate_budget.mjs",),
          ("tools/test_params_inflate_budget.mjs", "functions/_params_core.js", "site/assets/community/params-core.js"),
          r"^params inflate budget: PASS \([1-9][0-9]*/[1-9][0-9]*\)$",
          read="Synthetic PNG chunks and controlled decompression streams; no media or network"),
    Check("feedback_pagination", "node", ("tools/test_feedback_pagination.mjs",),
          ("tools/test_feedback_pagination.mjs",) + MODERATION_INPUTS,
          r"^feedback pagination: PASS \([1-9][0-9]*/[1-9][0-9]*\)$",
          read="Synthetic R2 metadata, encrypted list index and bounded feedback page fixtures"),
    Check("feedback_pagination_ui", "node", ("--experimental-vm-modules", "tools/test_feedback_pagination_ui.mjs"),
          ("tools/test_feedback_pagination_ui.mjs", "site/assets/admin/actions.js", "site/assets/admin/api.js",
           "site/assets/admin/render.js", "site/assets/admin/state.js", "site/assets/admin/editor.js",
           "site/assets/app/feedback-progress.js"),
          r"^feedback pagination UI: PASS \([1-9][0-9]*/[1-9][0-9]*\)$",
          read="Actual admin action/render/API modules; synthetic DOM, editor inputs and controlled fetch"),
    Check("history_resume", "node", ("tools/test_history_resume.mjs",),
          ("tools/test_history_resume.mjs", "site/assets/app/history.js", "site/assets/app.js",
           "site/assets/app/browser-history.js", "site/assets/app/router.js", "site/assets/app/data.js",
           "site/assets/app/favorites-view.js", "site/assets/app/site-search.js", "site/assets/app/state.js"),
          r"^history resume: PASS \([1-9][0-9]* cases\)$",
          read="Actual history script with controlled view promises/navigation and synthetic state/DOM"),
    Check("tag_relay_rail", "node", ("tools/test_tag_relay_rail.mjs",),
          ("tools/test_tag_relay_rail.mjs", "site/assets/app/tag-relay-rail.js",
           "site/assets/app/browser-history.js", "site/assets/app/modal.js", "site/assets/app/ui-motion.js", "site/assets/app/state.js"),
          r"^tag relay rail: PASS \([1-9][0-9]* cases\)$",
          read="Actual rail/ui-motion scripts with synthetic media query/focus/history and controlled WAAPI/layout lifecycle fixtures"),
    Check("browser_history", "node", ("tools/test_browser_history.mjs",),
          ("tools/test_browser_history.mjs", "site/assets/app/browser-history.js"), r"^browser history tests passed$"),
    Check("history_storage", "node", ("tools/test_history_storage.mjs",),
          ("tools/test_history_storage.mjs", "site/assets/app/history.js"), r"^history storage resilience tests passed$"),
    Check("resume_prompt", "node", ("tools/test_resume_prompt.mjs",),
          ("tools/test_resume_prompt.mjs", "site/assets/app/resume-prompt.js"), r"^resume prompt tests passed$"),
    Check("favorites_route", "node", ("tools/test_favorites_route.mjs",),
          ("tools/test_favorites_route.mjs", "site/assets/app/router.js", "site/assets/app/history.js",
           "site/assets/app/favorites-view.js", "site/assets/app/favorites-library-core.js"),
          r"^favorites route: folder codes, legacy paths, private capture and layered history passed$"),
    Check("modal_layers", "node", ("tools/test_modal_layers.mjs",),
          ("tools/test_modal_layers.mjs", "site/assets/app/modal.js", "site/assets/app/browser-history.js"),
          r"^modal layers regression: [1-9][0-9]* passed$"),
    Check("modal_dismiss", "node", ("tools/test_modal_dismiss.mjs",),
          ("tools/test_modal_dismiss.mjs", "site/assets/app/modal.js"), r"^modal dismiss regression: [1-9][0-9]* passed$"),
    Check("community_frontend", "node", ("tools/test_community_frontend.mjs",),
          ("tools/test_community_frontend.mjs", "site/assets/admin/actions.js", "site/assets/admin/api.js",
           "site/assets/admin/render.js", "site/assets/admin/state.js", "site/assets/admin/editor.js"),
          r"^community/admin frontend regressions: PASS$",
          read="Source contracts for community and administrator modules; synthetic DOM only"),
    Check("community_frontend_low_risk", "node", ("tools/test_community_frontend_low_risk.mjs",),
          ("tools/test_community_frontend_low_risk.mjs", "site/assets/admin/actions.js",
           "site/assets/admin/render.js", "site/assets/admin/editor.js"),
          r"^community/admin frontend low-risk regressions: PASS$", read="Source contracts and inline synthetic fixtures"),
    Check("cache_buster", "python", ("-B", "tools/check_cache_buster.py"),
          ("tools/check_cache_buster.py", "site/index.html", "site/strings.html", "site/review.html"),
          r"^OK: no JS/CSS cache buster leftovers found\.$",
          read="Listed HTML plus site/assets/**/*.js and **/*.css (source only)"),
    Check("data_source", "node", ("tools/test_data_source.mjs",),
          ("tools/test_data_source.mjs", "site/assets/data-source.js", "site/assets/data-release.js", "site/index.html"),
          r"^data-source tests passed$"),
    Check("search_data", "node", ("tools/test_search_data.mjs",),
          ("tools/test_search_data.mjs", "site/assets/app/search.js", "site/assets/app/data.js", "site/assets/app/site-search.js"),
          r"^search/data/site-search: PASS$"),
    Check("search_directories", "node", ("tools/test_search_directories.mjs",),
          ("tools/test_search_directories.mjs", "site/assets/app/search-directories.js"),
          r"^search directories: PASS$"),
    Check("masonry_viewport", "node", ("tools/test_masonry_viewport.mjs",),
          ("tools/test_masonry_viewport.mjs", "site/assets/app/masonry.js"),
          r"^masonry viewport and mobile density regressions: PASS$"),
    Check("render_ui", "node", ("tools/test_render_ui.mjs",),
          ("tools/test_render_ui.mjs", "site/assets/app.js", "site/assets/app/masonry.js", "site/assets/app/ui.js",
           "site/assets/app/MODULE_MAP.md", "site/assets/tag-relay.css", "tools/build_local_edition.py"),
          r"^render UI regressions: PASS$",
          read="Public HTML/CSS/JS source contracts and synthetic DOM fixtures; no site/data or browser"),
    Check("tag_relay_cache", "node", ("--experimental-vm-modules", "tools/test_tag_relay_cache.mjs"),
          ("tools/test_tag_relay_cache.mjs", "site/assets/app/tag-relay-store.js",
           "site/assets/app/tag-relay-v4.js", "site/assets/app/storage-coordinator.js"),
          r"^tag relay cache fence: all tests passed$",
          read="Real module graphs with independent in-memory renderer storage and synthetic Web Locks"),
    Check("tag_relay_access", "node", ("tools/test_tag_relay_access.mjs",),
          ("tools/test_tag_relay_access.mjs", "site/assets/app/tag-relay-compose.js",
           "site/assets/app/tag-relay-editor.js", "site/assets/app/tag-relay-text.js",
           "site/assets/app/tag-relay-v4.js", "site/assets/app/tag-relay-core.js",
           "site/assets/app/tag-relay-store.js", "site/assets/app/tag-relay-snapshot.js", "site/assets/app/copy.js"),
          r"^tag relay access: all tests passed$",
          read="Real module imports, synthetic DOM and in-memory storage/clipboard; copy buttons, history and access guards"),
    Check("storage_fence", "node", ("--experimental-vm-modules", "tools/test_storage_fence.mjs"),
          ("tools/test_storage_fence.mjs", "site/assets/app/tag-relay-store.js",
           "site/assets/app/tag-relay-v4.js", "site/assets/app/storage-coordinator.js"),
          r"^storage fence regressions: all passed$",
          read="Real module graphs with in-memory storage; no --baseline or --out arguments"),
    Check("codex_matching", "python", ("-B", "-m", "unittest", "tools.test_codex_update_match", "tools.test_suozhang_r18_merge_match"),
          ("tools/test_codex_update_match.py", "tools/test_suozhang_r18_merge_match.py",
           "tools/codex_update_match.py", "tools/suozhang_r18_merge_match.py", "tools/convert.py"),
          parser="unittest", write="Synthetic DOCX/JSON and rollback fixtures in temporary directories only"),
    Check("local_tool_transactions", "python", ("-B", "-m", "unittest", "tools.test_local_tool_transactions"),
          ("tools/test_local_tool_transactions.py", "tools/local_file_transaction.py",
           "tools/imgserver.py", "tools/strings_server.py"), parser="unittest",
          read="Listed local editor source and synthetic JSON/image bytes only",
          write="Temporary synthetic originals, thumbnails, JSON, before-images and failure fixtures only"),
    Check("strings_editor_state", "node", ("tools/test_strings_editor_state.mjs",),
          ("tools/test_strings_editor_state.mjs", "tools/strings_editor.html"),
          r"^strings editor state: PASS \([1-9][0-9]* cases\)$",
          read="Actual editor script in synthetic DOM/fetch with controlled request interleavings; no browser"),
    Check("pei_editor_state", "node", ("tools/test_pei_editor_state.mjs",),
          ("tools/test_pei_editor_state.mjs", "tools/pei.html"),
          r"^pei editor state: PASS \([1-9][0-9]* cases\)$",
          read="Actual image editor script with synthetic FileReader, DOM and controlled collection requests"),
    Check("python_tool_safety", "python", ("-B", "-m", "unittest", "tools.test_python_tool_safety"),
          ("tools/test_python_tool_safety.py", "tools/imgserver.py", "tools/strings_server.py",
           "tools/local_file_transaction.py", "tools/retire_r2_assets.py", "tools/takedown_pack_entries.py",
           "tools/sync_r2.py"), parser="unittest", timeout=120,
          write="Synthetic temporary media, JSON, backups and mocked maintenance inputs only",
          network="Temporary loopback editor fixtures only; remote operations mocked"),
    Check("runner", "python", ("-B", "-m", "unittest", "tools.test_run_project_checks"),
          ("tools/run_project_checks.py", "tools/test_run_project_checks.py"), parser="unittest",
          write="Temporary synthetic scripts, logs and output trees only; runner reports", timeout=120),
    Check("data_proxy", "node", ("tools/test_data_proxy.mjs",),
          ("tools/test_data_proxy.mjs", "functions/data/[[path]].js") + R2_READER_INPUTS, r"^data proxy tests passed$"),
    Check("share_backend", "node", ("tools/test_share_backend.mjs",),
          ("tools/test_share_backend.mjs", "functions/_share.js") + R2_READER_INPUTS, r"^share backend tests passed$"),
    Check("site_metrics_backend", "node", ("tools/test_site_metrics_backend.mjs",),
          ("tools/test_site_metrics_backend.mjs", "tools/sqlite-d1-test-harness.mjs",
           "functions/_site_metrics.js", "functions/api/site-metrics.js", "functions/api/admin/site-metrics.js",
           "migrations/0001_community_likes.sql", "migrations/0002_engagement_tombstones.sql",
           "migrations/0003_favorites_pickup.sql", "migrations/0004_submission_guards.sql", "migrations/0005_site_metrics.sql"),
          r"^PASS anonymous metrics backend: real SQLite migration, strict schema, disabled fallback, privacy, atomic throttle, retention, authenticated aggregates$",
          sqlite=True, read="Listed source and migration SQL; SQLite :memory: only"),
    Check("site_metrics_production", "node", ("tools/test_site_metrics_production.mjs",),
          ("tools/test_site_metrics_production.mjs", "tools/sqlite-d1-test-harness.mjs",
           "functions/_site_metrics.js", "functions/_site_metrics_read.js", "functions/api/site-metrics/report.js",
           "functions/api/admin/site-metrics.js", "tools/site-metrics-maintenance/worker.js", "migrations/0005_site_metrics.sql"),
          r"^PASS metrics read-only authorization, expiry, no administrator privileges, report schema, retention boundaries and unrelated-table preservation$",
          sqlite=True, read="Synthetic token, frozen clock and SQLite :memory: only; no production access"),
    Check("birthday_wishes_backend", "node", ("tools/test_birthday_wishes_backend.mjs",),
          ("tools/test_birthday_wishes_backend.mjs", "tools/sqlite-d1-test-harness.mjs", "functions/_birthday_wishes.js",
           "functions/api/birthday-wishes.js", "functions/_engagements.js", "functions/_lib.js",
           "migrations/0001_community_likes.sql", "migrations/0002_engagement_tombstones.sql",
           "migrations/0003_favorites_pickup.sql", "migrations/0004_submission_guards.sql",
           "migrations/0005_site_metrics.sql", "migrations/0006_birthday_wishes.sql"),
          r"^PASS birthday wishes backend: additive migration, UTC window, yearly totals, salted per-IP and global limits, strict request shape$",
          sqlite=True, read="Listed source and migration SQL; frozen clock and SQLite :memory: only"),
    Check("community_rebuild", "node", ("tools/test_community_rebuild.mjs",),
          ("tools/test_community_rebuild.mjs", "tools/memory-r2-test-harness.mjs", "functions/_lib.js",
           "functions/api/community.js", "functions/api/admin/community/[[path]].js", "functions/_record-store.js", "functions/_record-index.js"),
          r"^community aggregate concurrency: PASS \([1-9][0-9]* cases\)$",
          read="Listed source; synthetic in-memory R2 with controlled interleavings and content-hash ETags"),
    Check("moderation_concurrency", "node", ("tools/test_moderation_concurrency.mjs",),
          ("tools/test_moderation_concurrency.mjs",) + MODERATION_INPUTS,
          r"^moderation concurrency tests: PASS$",
          read="Real handlers with synthetic R2 and controlled stale requests, conditional writes and failures"),
    Check("record_store_edges", "node", ("tools/test_record_store_edges.mjs",),
          ("tools/test_record_store_edges.mjs",) + MODERATION_INPUTS,
          r"^record store edges: PASS \([1-9][0-9]* cases\)$",
          read="Synthetic paginated R2 metadata, 50001 retained records, malformed legacy JSON and controlled index failures"),
    Check("admin_community", "node", ("tools/test_admin_community_backend.mjs",),
          ("tools/test_admin_community_backend.mjs",) + MODERATION_INPUTS,
          r"^admin community memory flow: PASS$"),
    Check("admin_feedback", "node", ("tools/test_admin_feedback_backend.mjs",),
          ("tools/test_admin_feedback_backend.mjs", "site/assets/admin/editor.js") + MODERATION_INPUTS,
          r"^admin feedback memory flow: PASS$"),
    Check("community_low_risk", "node", ("tools/test_community_backend_low_risk.mjs",),
          ("tools/test_community_backend_low_risk.mjs",) + MODERATION_INPUTS,
          r"^community/backend low-risk regressions: PASS$"),
    Check("community_submit", "node", ("tools/test_community_submit_backend.mjs",),
          ("tools/test_community_submit_backend.mjs", "site/assets/community/params-core.js") + MODERATION_INPUTS,
          r"^community submit backend: PASS$"),
    Check("community_likes", "node", ("tools/test_community_likes_backend.mjs",),
          ("tools/test_community_likes_backend.mjs",) + MODERATION_INPUTS,
          r"^community likes backend: PASS$", sqlite=True,
          read="Synthetic R2 and SQLite :memory: with existing migration SQL; no production bindings"),
    Check("submission_guards", "node", ("tools/test_submission_guards.mjs",),
          ("tools/test_submission_guards.mjs",) + MODERATION_INPUTS,
          r"^submission guards: PASS$", sqlite=True,
          read="Synthetic R2, notification fetch stub and SQLite :memory:; no credentials or external requests"),
    Check("community_submit_recovery", "node", ("tools/test_community_submit_recovery.mjs",),
          ("tools/test_community_submit_recovery.mjs", "tools/memory-r2-test-harness.mjs",
           "tools/sqlite-d1-test-harness.mjs", "functions/api/submit.js", "functions/_lib.js",
           "functions/_params_core.js", "functions/_submission_guards.js", "functions/_record-store.js", "functions/_record-index.js", "migrations/0004_submission_guards.sql"),
          r"^community submission recovery: PASS \([1-9][0-9]* cases\)$",
          sqlite=True, read="Listed source and migration SQL; synthetic R2 fault injection and SQLite :memory: only"),
    Check("frontend_loading_recovery", "node", ("--experimental-vm-modules", "tools/test_frontend_loading_recovery.mjs"),
          ("tools/test_frontend_loading_recovery.mjs", "site/assets/app.js", "site/assets/app/tag-zh.js",
           "site/assets/app/tag-relay-compose.js",
           "site/assets/app/data.js", "site/assets/app/site-search.js", "site/assets/data-source.js",
           "site/assets/app/state.js", "site/assets/app/access.js", "site/assets/app/path-code.js",
           "site/assets/app/nai-default-tags.js", "site/assets/app/search.js", "site/assets/data-release.js"),
          r"^frontend loading recovery: [1-9][0-9]*/[1-9][0-9]* PASS; 0 FAIL$"),
    Check("feedback_list_budget", "node", ("tools/test_feedback_list_budget.mjs",),
          ("tools/test_feedback_list_budget.mjs", "tools/memory-r2-test-harness.mjs",
           "functions/api/admin/feedback.js", "functions/_feedback-list.js", "functions/_feedback.js", "functions/_lib.js", "functions/_record-store.js", "functions/_record-index.js"),
          r"^feedback list budget: PASS \([1-9][0-9]* cases\)$"),
    Check("feedback_list_client", "node", ("tools/test_feedback_list_client.mjs",),
          ("tools/test_feedback_list_client.mjs", "site/assets/admin/api.js", "site/assets/admin/state.js",
           "site/assets/app/feedback-progress.js"), r"^feedback list client: PASS \([1-9][0-9]* cases\)$"),
    Check("ui_result_states", "python", ("-B", "-m", "unittest", "tools.test_verify_ui"),
          ("tools/test_verify_ui.py", "tools/verify_ui.py", "tools/verify_frontend_loading_recovery.py"), parser="unittest",
          write="Synthetic CDP messages, temporary asset fixtures and result reports; no browser or network"),
    Check("publish_safety", "python", ("-B", "-m", "unittest", "tools.test_publish_safety", "tools.test_publish_data_r2", "tools.test_sync_r2"),
          ("tools/test_publish_safety.py", "tools/test_publish_data_r2.py", "tools/test_sync_r2.py",
           "tools/preview_server.py") + R2_RELEASE_INPUTS, parser="unittest", timeout=120,
          network="Synthetic loopback socket fixtures only; no external service requests",
          write="Synthetic temporary data/configuration and FakeR2 only; no real data, credentials or publishing"),
    Check("r2_cas_local", "python", ("-B", "-m", "unittest", "tools.test_r2_cas_experiment", "tools.test_r2_cas_store"),
          ("tools/test_r2_cas_experiment.py", "tools/test_r2_cas_store.py", "tools/r2_cas_experiment/protocol.py",
           "tools/r2_cas_experiment/publisher.py", "tools/r2_cas_experiment/store.py", "tools/r2_cas_experiment/lab.py",
           "tools/publish_data_r2.py", "tools/sync_r2.py") + R2_RELEASE_INPUTS, parser="unittest", timeout=120,
          read="Listed source and synthetic JSON only; production configuration is not loaded",
          write="Isolated output fixtures and SQLite stores only; no business data or remote writes",
          network="None; local lab entrypoint blocks sockets and production client construction"),
    Check("r2_cas_reader", "node", ("--test", "--test-reporter=tap", "tools/test_r2_cas_reader.mjs"),
          ("tools/test_r2_cas_reader.mjs", "tools/r2_cas_experiment/reader.mjs", "tools/fixtures/r2_cas_v2.json",
           "tools/r2_cas_experiment/protocol.py"), parser="node_test", timeout=90,
          read="Synthetic protocol bytes and listed source; Python subprocess checks cross-language identity",
          write="No business files; subprocess bytecode disabled", network="None; callbacks and synthetic bytes only"),
    Check("r2_publisher", "python", ("-B", "-m", "unittest", "tools.test_publish_data_r2_v2", "tools.test_build_updates_index"),
          ("tools/test_publish_data_r2_v2.py", "tools/test_publish_data_r2.py", "tools/test_build_updates_index.py",
           "tools/build_updates_index.py") + R2_RELEASE_INPUTS, parser="unittest", timeout=120,
          write="Synthetic temporary snapshots and local SQLite below output only; no business data or remote writes",
          network="None; local CLI cases block sockets and production configuration loading"),
    Check("r2_pool", "python", ("-B", "-m", "unittest", "tools.test_r2_connection_pool"),
          ("tools/test_r2_connection_pool.py", "tools/sync_r2.py", "tools/r2_http_pool.py"), parser="unittest", timeout=90,
          network="Loopback HTTP/CONNECT fixtures only; test factory redirects fake HTTPS endpoints to localhost",
          write="Temporary synthetic bytes and loopback server only; no business files or remote uploads"),
    Check("r2_protocol", "node", ("--test", "--test-reporter=tap", "tools/test_data_release.mjs"),
          ("tools/test_data_release.mjs", "site/assets/data-release.js", "tools/r2_data_protocol.py",
           "tools/fixtures/r2_cas_v2.json"), parser="node_test", timeout=90),
    Check("r2_compat", "node", ("tools/test_r2_data_compat.mjs",),
          ("tools/test_r2_data_compat.mjs", "workers/r2-data-compat/worker.js",
           "workers/r2-data-compat/config.example.jsonc") + R2_READER_INPUTS,
          r"^R2 data compatibility tests passed$", read="Synthetic bytes and in-memory bindings; no platform configuration or network"),
    Check("r2_verifier_safety", "python", ("-B", "-m", "unittest", "tools.test_verify_r2_cas_integration", "tools.test_verify_r2_reading_browser"),
          ("tools/test_verify_r2_cas_integration.py", "tools/test_verify_r2_reading_browser.py",
           "tools/verify_r2_cas_integration.py", "tools/verify_r2_reading_browser.py",
           "tools/verify_frontend_loading_recovery.py", "tools/verify_ui.py") + R2_RELEASE_INPUTS,
          parser="unittest", timeout=90, write="Synthetic sentinel/output guard fixtures only; no real browser or business files"),
    Check("r2_platform_cli_safety", "python", ("-B", "-m", "unittest", "tools.test_verify_r2_platform_s3", "tools.test_verify_r2_platform_http"),
          ("tools/test_verify_r2_platform_s3.py", "tools/test_verify_r2_platform_http.py",
           "tools/verify_r2_platform_s3.py", "tools/verify_r2_platform_http.py") + R2_RELEASE_INPUTS,
          parser="unittest", timeout=90, write="Synthetic resource manifests and temporary output guards only; no platform requests",
          network="None; mocks exercise default-plan and target/credential isolation, never --run against a real service"),
    Check("r2_platform_worker", "node", ("tools/test_r2_platform_worker.mjs",),
          ("tools/test_r2_platform_worker.mjs", "workers/r2-platform-test/worker.js",
           "workers/r2-data-compat/worker.js") + R2_READER_INPUTS,
          r"^R2 platform test Worker guards and synthetic cases passed$",
          write="In-memory synthetic binding only; no deployment or real R2",
          network="None; global fetch is replaced by a fail-closed stub"),
    Check("search_benchmark_public", "node", ("tools/test_benchmark_search_v1.mjs",),
          ("tools/test_benchmark_search_v1.mjs", "tools/benchmark_search_v1.mjs", "tools/fixtures/search_benchmark.json",
           "site/assets/app/search.js", "site/assets/app/search-directories.js", "site/assets/app/state.js",
           "site/assets/app/access.js", "site/assets/app/path-code.js"),
          r"^search benchmark harness: PASS \(public semantics, changed input, distributions, snapshots and comparison guard\)$",
          write="Temporary public synthetic JSON only; no private data or performance improvement claim"),
    Check("publish_entrypoints", "python", ("-B", "-m", "unittest", "tools.test_publish_entrypoints"),
          ("tools/test_publish_entrypoints.py", "单项工具/发布.bat", "单项工具/发布数据.bat"),
          parser="unittest", platform="nt", write="Temporary copies and fake executables only; no real publishing", timeout=60),
    Check("audit_entrypoints", "python", ("-B", "-m", "unittest", "tools.test_project_audit_entrypoints"),
          ("tools/test_project_audit_entrypoints.py", "单项工具/工程自检.bat", "法典图鉴.bat"),
          parser="unittest", platform="nt", write="Temporary copies and fake executables only", timeout=60),
    Check("nai_default_tags", "node", ("tools/test_nai_default_tags.mjs",),
          ("tools/test_nai_default_tags.mjs", "tools/fixtures/nai_default_tags.json",
           "site/assets/app/nai-default-tags.js", "site/assets/app/data.js", "site/assets/app/state.js",
           "site/assets/data-source.js", "site/assets/app/path-code.js"),
          r"^NAI default tags: [1-9][0-9]* shared boundary cases and loading integration passed$"),
    Check("nai_default_tags_community", "node", ("tools/test_nai_default_tags_community.mjs",),
          ("tools/test_nai_default_tags_community.mjs", "site/assets/app/community-codex.js",
           "site/assets/app/data.js", "site/assets/app/state.js", "site/assets/app/nai-default-tags.js", "site/assets/data-source.js"),
          r"^NAI default tags community: PASS \(adapter and live loading integration\)$",
          blocked_marker=r"^NAI default tags community: BLOCKED \(.+\)$"),
    Check("search_benchmark", "node", ("tools/benchmark_search_v1.mjs",),
          ("tools/benchmark_search_v1.mjs", "tools/fixtures/search_benchmark.json", "site/data/codexes.json",
           "site/assets/app/search.js", "site/assets/app/search-directories.js", "site/assets/app/state.js",
           "site/assets/app/access.js", "site/assets/app/path-code.js"),
          r"^search V1 benchmark: PASS$", private_data=True, timeout=180,
          read="Private site/data/codexes.json and exactly its listed <id>.json files; source modules. No media.",
          blocked_marker=r"^search V1 benchmark: BLOCKED \(.+\)$"),
    Check("search_legacy_comparison", "node", ("tools/benchmark_search_v1.mjs", "--compare-legacy"),
          ("tools/benchmark_search_v1.mjs", "tools/fixtures/search_benchmark.json", "site/data/codexes.json",
           "site/assets/app/search.js", "site/assets/app/search-directories.js", "site/assets/app/state.js",
           "site/assets/app/access.js", "site/assets/app/path-code.js"),
          r"^search V1 benchmark: PASS$", private_data=True, timeout=180,
          read="Private JSON snapshot; legacy/current recall equality is required before same-input timings.",
          blocked_marker=r"^search V1 benchmark: BLOCKED \(.+\)$"),
)
PROFILES = {
    "p2": ("record_store_edges", "stable_entry_ids", "edit_server", "params_inflate_budget", "feedback_pagination", "feedback_pagination_ui",
           "history_resume", "tag_relay_rail", "browser_history", "history_storage", "resume_prompt", "favorites_route",
           "modal_layers", "modal_dismiss", "community_frontend", "community_frontend_low_risk",
           "admin_feedback", "feedback_list_budget", "feedback_list_client", "community_submit",
           "community_submit_recovery", "submission_guards", "moderation_concurrency", "cache_buster", "runner"),
    "p1": ("record_store_edges", "local_tool_transactions", "strings_editor_state", "pei_editor_state", "python_tool_safety", "moderation_concurrency",
           "admin_community", "admin_feedback", "community_low_risk", "community_submit", "community_likes",
           "submission_guards", "community_rebuild", "community_submit_recovery", "feedback_list_budget",
           "feedback_list_client", "cache_buster", "runner"),
    "r2_platform_safety": ("r2_platform_cli_safety", "r2_platform_worker", "runner", "cache_buster"),
    "r2_integration": ("r2_publisher", "r2_pool", "r2_protocol", "r2_compat", "r2_verifier_safety", "publish_safety", "publish_entrypoints",
                       "data_source", "data_proxy", "share_backend", "frontend_loading_recovery",
                       "r2_cas_local", "r2_cas_reader", "runner", "cache_buster"),
    "r2_cas": ("r2_cas_local", "r2_cas_reader", "runner", "publish_safety", "data_source", "data_proxy", "share_backend", "cache_buster"),
    "quick": ("cache_buster", "data_source", "search_data", "search_directories", "masonry_viewport", "tag_relay_access", "runner"),
    "ci": ("record_store_edges", "cache_buster", "data_source", "search_data", "search_directories", "masonry_viewport", "runner",
           "stable_entry_ids", "params_inflate_budget", "feedback_pagination", "feedback_pagination_ui", "history_resume", "tag_relay_rail",
           "local_tool_transactions", "strings_editor_state", "pei_editor_state", "moderation_concurrency",
           "render_ui", "tag_relay_cache", "tag_relay_access", "storage_fence", "codex_matching",
           "data_proxy", "share_backend", "site_metrics_backend", "site_metrics_production", "birthday_wishes_backend",
           "community_rebuild", "community_submit_recovery",
           "frontend_loading_recovery", "feedback_list_budget", "feedback_list_client", "ui_result_states",
           "publish_safety", "search_benchmark_public", "nai_default_tags"),
    "windows": ("publish_entrypoints", "audit_entrypoints"),
    "baseline": ("nai_default_tags_community", "search_benchmark", "search_legacy_comparison"),
}


def selected_checks(profile):
    by_id = {check.id: check for check in CHECKS}
    return [by_id[name] for name in PROFILES[profile]]


def safe_path(root, path):
    """Accept only paths below root, without symlinks, junctions or reparse points."""
    root = Path(root).resolve()
    candidate = Path(path)
    if not candidate.is_absolute():
        candidate = root / candidate
    candidate = Path(os.path.abspath(candidate))
    try:
        parts = candidate.relative_to(root).parts
    except ValueError as error:
        raise ValueError("path is outside repository") from error
    cursor = root
    for part in parts:
        cursor /= part
        try:
            info = cursor.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError("symlink/junction/reparse point is not allowed: " + str(cursor))
    if not candidate.resolve().is_relative_to(root):
        raise ValueError("resolved path is outside repository")
    return candidate


def create_output_dir(root, requested=None):
    suffix = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:10]
    path = safe_path(root, requested or (Path("output/project-audit/checks") / suffix))
    if path == Path(root).resolve() or path.exists():
        raise ValueError("output directory already exists; choose a new run directory")
    path.parent.mkdir(parents=True, exist_ok=True)
    safe_path(root, path)  # Recheck newly created parent chain before exclusive creation.
    path.mkdir(exist_ok=False)
    (path / "logs").mkdir()
    return path


def clean_environment(source=None, runtime_paths=()):
    source = os.environ if source is None else source
    keep = {"SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ"}
    env = {key: value for key, value in source.items() if key.upper() in keep}
    directories = [str(Path(item).resolve().parent) for item in runtime_paths if item]
    system_root = next((value for key, value in env.items() if key.upper() == "SYSTEMROOT"), None)
    if os.name == "nt" and system_root:
        directories.extend([str(Path(system_root) / "System32"), system_root])
    elif os.name != "nt":
        directories.extend(["/usr/bin", "/bin"])
    env["PATH"] = os.pathsep.join(dict.fromkeys(directories))
    env.update(PYTHONDONTWRITEBYTECODE="1", PYTHONUTF8="1", PYTHONIOENCODING="utf-8", NO_COLOR="1")
    return env


def run_process(argv, cwd, env, timeout):
    """Bound execution and terminate the whole child tree on timeout."""
    started = time.monotonic()
    options = {"start_new_session": True} if os.name != "nt" else {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
    try:
        process = subprocess.Popen(argv, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, **options)
    except OSError as error:
        return {"executed": False, "returncode": None, "timed_out": False, "seconds": 0,
                "output": str(error), "termination_error": None}
    timed_out = False
    termination_error = None
    try:
        output, _ = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            if os.name == "nt":
                system_root = next((v for k, v in env.items() if k.upper() == "SYSTEMROOT"), "C:/Windows")
                killed = subprocess.run([str(Path(system_root) / "System32/taskkill.exe"), "/PID", str(process.pid), "/T", "/F"],
                                        env=env, capture_output=True, timeout=10)
                if killed.returncode:
                    termination_error = "taskkill returned " + str(killed.returncode)
                    process.kill()
            else:
                os.killpg(process.pid, signal.SIGKILL)
        except (OSError, subprocess.TimeoutExpired) as error:
            termination_error = str(error)
            process.kill()
        try:
            output, _ = process.communicate(timeout=5)
        except subprocess.TimeoutExpired as error:
            output = error.output or b""
            termination_error = "child pipes remained open after termination; descendants may remain"
            process.stdout.close()
    return {"executed": True, "returncode": process.returncode, "timed_out": timed_out,
            "seconds": round(time.monotonic() - started, 3), "output": output.decode("utf-8", "replace"),
            "termination_error": termination_error}


def discover_runtimes():
    paths = {"python": sys.executable, "node": shutil.which("node"), "git": shutil.which("git")}
    env = clean_environment(runtime_paths=paths.values())
    runtimes = {}
    for name, executable in paths.items():
        info = {"path": executable, "available": False, "version": None, "sqlite": False}
        if executable:
            probe = run_process([executable, "--version"], ROOT, env, 10)
            info["available"] = probe["returncode"] == 0 and not probe["timed_out"]
            info["version"] = probe["output"].strip()
            if name == "node" and info["available"]:
                sqlite = run_process([executable, "-e", "require('node:sqlite'); console.log('SQLITE_READY')"], ROOT, env, 10)
                info["sqlite"] = sqlite["returncode"] == 0 and not sqlite["timed_out"] and "SQLITE_READY" in sqlite["output"]
        runtimes[name] = info
    return runtimes, env


def check_inputs(check, root):
    inputs = list(check.inputs)
    errors = []
    if check.private_data:
        try:
            index = safe_path(root, "site/data/codexes.json")
            metas = json.loads(index.read_text(encoding="utf-8"))
            if not isinstance(metas, list) or not metas:
                raise ValueError("codexes.json must be a nonempty array")
            for meta in metas:
                identifier = str(meta.get("id", "")).strip() if isinstance(meta, dict) else ""
                if not re.fullmatch(r"[A-Za-z0-9_-]+", identifier):
                    raise ValueError("unsafe or missing codex id in private data index")
                inputs.append("site/data/" + identifier + ".json")
        except (OSError, ValueError) as error:
            errors.append("private fixture index unavailable/invalid: " + str(error))
    for name in inputs:
        try:
            if not safe_path(root, name).is_file():
                errors.append("missing required input: " + name)
        except ValueError as error:
            errors.append(str(error))
    return sorted(set(inputs)), errors


def classify(check, process):
    result = {"status": "FAIL", "reason": "", "unittest_cases_reported": None, "unittest_skipped": None}
    output = process["output"].replace("\r\n", "\n")
    counts = re.findall(r"^Ran (\d+) tests? in [0-9.]+s[ \t]*$", output, re.MULTILINE) if check.parser == "unittest" else []
    if len(counts) == 1:
        result["unittest_cases_reported"] = int(counts[0])
    skipped_counts = re.findall(r"^(?:OK|FAILED)\s*\([^\n]*\bskipped=(\d+)[^\n]*\)[ \t]*$", output, re.MULTILINE)
    if check.parser == "unittest":
        result["unittest_skipped"] = int(skipped_counts[0]) if len(skipped_counts) == 1 else 0
    if not process["executed"]:
        result.update(status="BLOCKED", reason="child could not start")
        return result
    if process["timed_out"]:
        result["reason"] = "timeout; required check did not complete"
        return result
    if process["returncode"] != 0:
        if (process["returncode"] == 2 and check.blocked_marker
                and len(re.findall(check.blocked_marker, output, re.MULTILINE)) == 1
                and not (check.marker and re.search(check.marker, output, re.MULTILINE))):
            result.update(status="BLOCKED" if check.required else "SKIP", reason="declared prerequisite/comparability condition not met")
            return result
        result["reason"] = "nonzero process exit"
        return result
    if check.parser == "unittest":
        summaries = re.findall(r"^OK(?: \(([^\n]*)\))?[ \t]*$", output, re.MULTILINE)
        if len(counts) != 1 or len(summaries) != 1:
            result["reason"] = "missing/ambiguous unittest Ran N + OK completion summary"
            return result
        skipped = re.search(r"skipped=(\d+)", summaries[0])
        result["unittest_skipped"] = int(skipped.group(1)) if skipped else 0
        if int(counts[0]) == 0:
            result["reason"] = "zero unittest cases"
            return result
        if result["unittest_skipped"]:
            result.update(status="BLOCKED" if check.required else "SKIP", reason="unittest skipped cases; not fully verified")
            return result
        if summaries[0]:
            result["reason"] = "unexpected unittest summary qualifiers: " + summaries[0]
            return result
    elif check.parser == "node_test":
        fields = ("tests", "pass", "fail", "cancelled", "skipped", "todo")
        summary = {}
        for field in fields:
            matches = re.findall(r"^# " + field + r" ([0-9]+)[ \t]*$", output, re.MULTILINE)
            if len(matches) != 1:
                result["reason"] = "missing/ambiguous Node test summary: " + field
                return result
            summary[field] = int(matches[0])
        result["node_test_cases_reported"] = summary["tests"]
        if not summary["tests"] or summary["fail"] or summary["cancelled"]:
            result["reason"] = "zero, failed or cancelled Node test cases"
            return result
        if summary["skipped"] or summary["todo"]:
            result.update(status="BLOCKED" if check.required else "SKIP", reason="Node test skipped/todo cases; not fully verified")
            return result
        if summary["pass"] != summary["tests"]:
            result["reason"] = "incomplete Node test pass count"
            return result
    else:
        # A successful marker cannot cancel an explicit skip elsewhere in a script.
        if re.search(r"\b(?:SKIP|SKIPPED)\b", output, re.IGNORECASE):
            result.update(status="BLOCKED" if check.required else "SKIP", reason="script reported skip; not verified")
            return result
        if not check.marker or len(re.findall(check.marker, output, re.MULTILINE)) != 1:
            result["reason"] = "missing/ambiguous expected script completion marker"
            return result
    result.update(status="PASS", reason="expected completion evidence observed")
    return result


def execute_check(check, root, runtimes, env, log_dir):
    inputs, errors = check_inputs(check, root)
    runtime = runtimes.get(check.runtime, {})
    result = {**asdict(check), "resolved_inputs": inputs, "executed": False, "status": "BLOCKED",
              "reason": "", "argv": [], "returncode": None, "seconds": 0, "timed_out": False,
              "unittest_cases_reported": None, "unittest_skipped": None, "log": "logs/" + check.id + ".log"}
    if check.platform != "any" and check.platform != os.name:
        errors.append("requires platform " + check.platform)
    if not runtime.get("available"):
        errors.append("required runtime unavailable: " + check.runtime)
    if check.sqlite and not runtime.get("sqlite"):
        errors.append("required runtime feature unavailable: node:sqlite")
    if errors:
        result["status"] = "BLOCKED" if check.required else "SKIP"
        result["reason"] = "; ".join(errors)
        output = result["reason"] + "\n"
    else:
        result["argv"] = [runtime["path"], *check.args]
        process = run_process(result["argv"], root, env, check.timeout)
        output = process.pop("output")
        result.update(classify(check, {**process, "output": output}), **process)
    (Path(log_dir) / (check.id + ".log")).write_text(output, encoding="utf-8")
    return result


def snapshot_inputs(root, checks):
    """Hash declared inputs and source scopes, never images or credential files."""
    names = {"tools/run_project_checks.py"}
    errors = []
    for check in checks:
        inputs, input_errors = check_inputs(check, root)
        names.update(inputs)
        errors.extend(check.id + ": " + error for error in input_errors)
    # Broader source snapshots cover transitive JS imports without pretending to
    # discover executable tests. Paths and hashes are evidence, not extra checks.
    scopes = [] if all(check.platform == "nt" for check in checks) else [("site/assets", {".js", ".css"}), ("functions", {".js"})]
    for scope, suffixes in scopes:
        try:
            start = safe_path(root, scope)
            if not start.is_dir():
                raise ValueError("missing source scope: " + scope)
            def scan_error(error):
                errors.append("source scan failed (" + scope + "): " + str(error))

            for directory, children, files in os.walk(start, followlinks=False, onerror=scan_error):
                for child in list(children):
                    safe_path(root, Path(directory) / child)
                for name in files:
                    path = Path(directory) / name
                    if path.suffix in suffixes:
                        names.add(path.relative_to(root).as_posix())
        except (OSError, ValueError) as error:
            errors.append("source scan failed (" + scope + "): " + str(error))
    fingerprints = {}
    for name in sorted(names):
        try:
            path = safe_path(root, name)
            content = path.read_bytes()
            fingerprints[name] = {"sha256": hashlib.sha256(content).hexdigest(), "bytes": len(content)}
        except (OSError, ValueError) as error:
            fingerprints[name] = {"error": str(error)}
            errors.append("fingerprint failed (" + name + "): " + str(error))
    digest = hashlib.sha256(json.dumps(fingerprints, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
    return {"sha256": digest, "files": fingerprints, "errors": errors,
            "source_scopes": [scope for scope, _ in scopes], "media_scanned": False}


def git_metadata(root, runtimes, env):
    git = runtimes.get("git", {})
    if not git.get("available"):
        return {"available": False, "reason": "Git unavailable; source file hashes still recorded"}
    result = {"available": True}
    prefix = [git["path"], "--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false"]
    commands = {
        "head": ["rev-parse", "HEAD"],
        "status_tracked": ["status", "--porcelain=v1", "--untracked-files=no"],
        "diff_stat": ["diff", "--no-ext-diff", "--no-textconv", "--stat", "HEAD"],
        "diff_bytes": ["diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD"],
    }
    for key, args in commands.items():
        probe = run_process(prefix + args, root, env, 15)
        if probe["returncode"] != 0 or probe["timed_out"]:
            result.update(available=False, reason="Git metadata command failed: " + key)
        elif key == "diff_bytes":
            result["diff_sha256"] = hashlib.sha256(probe["output"].encode("utf-8")).hexdigest()
        else:
            result[key] = probe["output"].strip()
    result["untracked_note"] = "Untracked files are not in git diff; declared source hashes include selected new files."
    return result


def summarize(results, evidence_stable=True):
    counts = Counter(result["status"] for result in results)
    failures = any(result["status"] == "FAIL" for result in results)
    blocked = not results or not evidence_stable or any(result["required"] and result["status"] != "PASS" for result in results)
    exit_code = 1 if failures else 2 if blocked else 0
    return {"status": "FAIL" if failures else "BLOCKED" if blocked else "PASS", "exit_code": exit_code,
            "counts": {state: counts[state] for state in STATES}, "selected_checks": len(results),
            "executed_check_scripts": sum(bool(result["executed"]) for result in results),
            "unittest_cases_reported": sum(result.get("unittest_cases_reported") or 0 for result in results),
            "unittest_skipped": sum(result.get("unittest_skipped") or 0 for result in results),
            "node_internal_assertion_count": None}


def markdown_report(report):
    summary = report["summary"]
    lines = ["# Selected project checks: " + summary["status"], "",
             "Scope: `" + report["profile"] + "`. Only the selected checks are covered.", "",
             "## Known baseline exclusions / limitations", ""]
    lines.extend("- " + value for value in KNOWN_BASELINE_LIMITS)
    lines += ["- Run `--profile baseline` to inspect these separately; they are not waived or considered passing.", "",
              "## Results", "", "| Check | State | Executed | Evidence / reason |", "| --- | --- | --- | --- |"]
    for result in report["checks"]:
        reason = result["reason"].replace("|", "\\|").replace("\n", " ")
        lines.append(f"| {result['id']} | {result['status']} | {result['executed']} | {reason}; [log]({result['log']}) |")
    lines += ["", f"Selected checks: {summary['selected_checks']}; executed check scripts: {summary['executed_check_scripts']}; "
              f"unittest cases reported: {summary['unittest_cases_reported']}; unittest skipped: {summary['unittest_skipped']}.",
              "Node internal assertion counts: unknown (not inferred from one script marker).", "",
              "Exit code: " + str(summary["exit_code"]) + "; evidence stable: " + str(report["evidence_stable"]) + ".", "",
              "HEAD: `" + str(report["git_before"].get("head", "unavailable")) + "`", "",
              "Source snapshot SHA-256: `" + report["inputs_before"]["sha256"] + "`", "",
              "Full argv, runtime versions, source hashes, declared side effects, and before/after evidence are in `report.json`.", "",
              "## Not verified", ""]
    lines.extend("- " + value for value in LIMITATIONS)
    return "\n".join(lines) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=PROFILES, default="quick")
    parser.add_argument("--list", action="store_true", help="List selected checks and side effects; do not execute or write")
    parser.add_argument("--output-dir", help="New report directory inside the repository; never overwrite")
    args = parser.parse_args(argv)
    checks = selected_checks(args.profile)
    if args.list:
        print(json.dumps({"profile": args.profile, "checks": [asdict(check) for check in checks],
                          "known_baseline_limits": KNOWN_BASELINE_LIMITS, "limitations": LIMITATIONS}, ensure_ascii=True, indent=2))
        return 0
    try:
        output = create_output_dir(ROOT, args.output_dir)
    except (OSError, ValueError) as error:
        print("BLOCKED: invalid output directory: " + str(error), file=sys.stderr)
        return 2
    runtimes, env = discover_runtimes()
    before = snapshot_inputs(ROOT, checks)
    git_before = git_metadata(ROOT, runtimes, env)
    results = []
    for check in checks:
        print("RUN " + check.id, flush=True)
        result = execute_check(check, ROOT, runtimes, env, output / "logs")
        results.append(result)
        print(result["status"] + " " + check.id + ": " + result["reason"], flush=True)
    after = snapshot_inputs(ROOT, checks)
    git_after = git_metadata(ROOT, runtimes, env)
    stable = before["sha256"] == after["sha256"] and not before["errors"] and not after["errors"]
    # HEAD changes invalidate a run even when named file bytes happen to match.
    stable = stable and git_before.get("head") == git_after.get("head")
    report = {
        "schema_version": 1, "created_at_utc": datetime.now(timezone.utc).isoformat(), "profile": args.profile,
        "root": str(ROOT), "argv": sys.argv if argv is None else [str(Path(__file__)), *argv],
        "summary": summarize(results, stable), "checks": results, "runtimes": runtimes,
        "child_environment_keys": sorted(env), "git_before": git_before, "git_after": git_after,
        "inputs_before": before, "inputs_after": after, "evidence_stable": stable,
        "known_baseline_limits": KNOWN_BASELINE_LIMITS, "limitations": LIMITATIONS,
    }
    (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (output / "report.md").write_text(markdown_report(report), encoding="utf-8")
    print(report["summary"]["status"] + ": " + str(output / "report.md"), flush=True)
    return report["summary"]["exit_code"]


if __name__ == "__main__":
    raise SystemExit(main())
