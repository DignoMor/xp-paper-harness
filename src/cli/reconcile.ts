import { ensureDir } from "../infrastructure/fs/atomic.js";
import { compose } from "../composition.js";
import { loadConfig } from "../config.js";
import { reconciliationExitCode } from "../application/reconciliation-service.js";

interface CliOptions {
  repair: boolean;
  deep: boolean;
  dataRoot?: string;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { repair: false, deep: false, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--repair") options.repair = true;
    else if (arg === "--deep") options.deep = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--data-root") {
      const value = argv[i + 1];
      if (!value) throw new Error("--data-root requires a path");
      options.dataRoot = value;
      i += 1;
    } else if (arg.startsWith("--data-root=")) {
      options.dataRoot = arg.slice("--data-root=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

const HELP = `Paper Harness reconciliation

Usage: node dist/cli/reconcile.js [--repair] [--deep] [--json] [--data-root <path>]

  --repair     Apply only known-safe repairs (create missing Paper Notes, normalize managed frontmatter).
  --deep       Recompute every Attachment SHA-256 during verification.
  --json       Emit the full structured report as JSON.
  --data-root  Override PAPER_HARNESS_DATA_ROOT.

Exit status: 0 when no errors remain, 2 when errors remain, 1 on failure to run.
`;

export async function runReconcileCli(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const effectiveEnv = { ...env };
  if (options.dataRoot) effectiveEnv.PAPER_HARNESS_DATA_ROOT = options.dataRoot;
  const config = loadConfig(effectiveEnv);
  const composition = await compose({ env: effectiveEnv, config });
  try {
    await ensureDir(config.dataRoot);
    await ensureDir(composition.services.paths.notesDir());
    const report = await composition.services.reconciliation.reconcile({
      repair: options.repair,
      deep: options.deep,
    });
    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(
        [
          `Reconciliation (${report.mode}${report.deep ? ", deep" : ""}) at ${report.generated_at}`,
          `Catalog revision: ${report.catalog_revision ?? "unavailable"}`,
          `Issues: ${report.summary.errors} error(s), ${report.summary.warnings} warning(s), ${report.summary.infos} info(s)`,
          `Repaired: ${report.summary.repaired}`,
          "",
          ...report.issues.map(
            (issue) =>
              `[${issue.severity}] ${issue.code}: ${issue.message}` +
              (issue.paper_id ? ` (paper ${issue.paper_id})` : "") +
              (issue.repairable ? " [repairable]" : ""),
          ),
          ...(report.repaired.length > 0
            ? ["", "Repairs applied:", ...report.repaired.map((issue) => `- ${issue.code}: ${issue.message}`)]
            : []),
          "",
        ].join("\n"),
      );
    }
    return reconciliationExitCode(report);
  } finally {
    await composition.dispose();
  }
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (isEntrypoint) {
  runReconcileCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exit(1);
    });
}
