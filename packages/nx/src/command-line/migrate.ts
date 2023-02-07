import * as chalk from 'chalk';
import { exec, execSync } from 'child_process';
import { prompt } from 'enquirer';
import { dirname, join } from 'path';
import {
  clean,
  coerce,
  gt,
  gte,
  lt,
  lte,
  major,
  satisfies,
  valid,
} from 'semver';
import { promisify } from 'util';
import {
  MigrationsJson,
  PackageJsonUpdateForPackage,
  PackageJsonUpdates,
} from '../config/misc-interfaces';
import { NxJsonConfiguration } from '../config/nx-json';
import { flushChanges, FsTree, printChanges } from '../generators/tree';
import {
  extractFileFromTarball,
  JsonReadOptions,
  readJsonFile,
  writeJsonFile,
} from '../utils/fileutils';
import { logger } from '../utils/logger';
import {
  NxMigrationsConfiguration,
  PackageGroup,
  PackageJson,
  readModulePackageJson,
  readNxMigrateConfig,
} from '../utils/package-json';
import {
  createTempNpmDirectory,
  detectPackageManager,
  getPackageManagerCommand,
  packageRegistryPack,
  packageRegistryView,
  resolvePackageVersionUsingRegistry,
} from '../utils/package-manager';
import { handleErrors } from '../utils/params';
import { connectToNxCloudCommand } from './connect';
import { output } from '../utils/output';
import { messages, recordStat } from '../utils/ab-testing';
import { nxVersion } from '../utils/versions';

export interface ResolvedMigrationConfiguration extends MigrationsJson {
  packageGroup?: NxMigrationsConfiguration['packageGroup'];
}

const execAsync = promisify(exec);

export function normalizeVersion(version: string) {
  const [semver, prereleaseTag] = version.split('-');
  const [major, minor, patch] = semver.split('.');

  const newSemver = `${major || 0}.${minor || 0}.${patch || 0}`;

  const newVersion = prereleaseTag
    ? `${newSemver}-${prereleaseTag}`
    : newSemver;

  const withoutPatch = `${major || 0}.${minor || 0}.0`;
  const withoutPatchAndMinor = `${major || 0}.0.0`;

  const variationsToCheck = [
    newVersion,
    newSemver,
    withoutPatch,
    withoutPatchAndMinor,
  ];

  for (const variation of variationsToCheck) {
    try {
      if (gt(variation, '0.0.0')) {
        return variation;
      }
    } catch {}
  }

  return '0.0.0';
}

function cleanSemver(version: string) {
  return clean(version) ?? coerce(version);
}

function normalizeSlashes(packageName: string): string {
  return packageName.replace(/\\/g, '/');
}

export interface MigratorOptions {
  packageJson: PackageJson;
  getInstalledPackageVersion: (
    pkg: string,
    overrides: Record<string, string>
  ) => string;
  fetch: (
    pkg: string,
    version: string
  ) => Promise<ResolvedMigrationConfiguration>;
  from: { [pkg: string]: string };
  to: { [pkg: string]: string };
  interactive?: boolean;
}

export class Migrator {
  private readonly packageJson: MigratorOptions['packageJson'];
  private readonly getInstalledPackageVersion: MigratorOptions['getInstalledPackageVersion'];
  private readonly fetch: MigratorOptions['fetch'];
  private readonly installedPkgVersionOverrides: MigratorOptions['from'];
  private readonly to: MigratorOptions['to'];
  private readonly interactive: MigratorOptions['interactive'];
  private readonly packageJsonUpdates: Record<
    string,
    PackageJsonUpdateForPackage
  > = {};
  private readonly collectedVersions: Record<string, string> = {};

  constructor(opts: MigratorOptions) {
    this.packageJson = opts.packageJson;
    this.getInstalledPackageVersion = opts.getInstalledPackageVersion;
    this.fetch = opts.fetch;
    this.installedPkgVersionOverrides = opts.from;
    this.to = opts.to;
    this.interactive = opts.interactive;
  }

  async updatePackageJson(targetPackage: string, targetVersion: string) {
    await this.buildPackageJsonUpdates(targetPackage, {
      version: targetVersion,
      addToPackageJson: false,
    });

    const migrations = await this.createMigrateJson();
    return { packageJson: this.packageJsonUpdates, migrations };
  }

  private async createMigrateJson() {
    const migrations = await Promise.all(
      Object.keys(this.packageJsonUpdates).map(async (packageName) => {
        const currentVersion = this.getPkgVersion(packageName);
        if (currentVersion === null) return [];

        const { version } = this.packageJsonUpdates[packageName];
        const { generators } = await this.fetch(packageName, version);

        if (!generators) return [];

        return Object.entries(generators)
          .filter(
            ([, migration]) =>
              migration.version &&
              this.gt(migration.version, currentVersion) &&
              this.lte(migration.version, version) &&
              this.areRequirementsMet(migration.requires)
          )
          .map(([migrationName, migration]) => ({
            ...migration,
            package: packageName,
            name: migrationName,
          }));
      })
    );

    return migrations.flat();
  }

  private async buildPackageJsonUpdates(
    targetPackage: string,
    target: PackageJsonUpdateForPackage
  ): Promise<void> {
    const packagesToCheck =
      await this.populatePackageJsonUpdatesAndGetPackagesToCheck(
        targetPackage,
        target
      );
    for (const packageToCheck of packagesToCheck) {
      const filteredUpdates: Record<string, PackageJsonUpdateForPackage> = {};
      for (const packageUpdate of packageToCheck.updates) {
        if (
          this.areRequirementsMet(packageUpdate.requires, filteredUpdates) &&
          (!this.interactive ||
            (await this.runPackageJsonUpdatesConfirmationPrompt(
              packageUpdate['x-prompt']
            )))
        ) {
          Object.entries(packageUpdate.packages).forEach(([name, update]) => {
            filteredUpdates[name] = update;
          });
        }
      }

      await Promise.all(
        Object.entries(filteredUpdates).map(([name, update]) =>
          this.buildPackageJsonUpdates(name, update)
        )
      );
    }
  }

  private async populatePackageJsonUpdatesAndGetPackagesToCheck(
    targetPackage: string,
    target: PackageJsonUpdateForPackage
  ): Promise<
    {
      package: string;
      updates: PackageJsonUpdates[string][];
    }[]
  > {
    let targetVersion = target.version;
    if (this.to[targetPackage]) {
      targetVersion = this.to[targetPackage];
    }

    if (!this.getPkgVersion(targetPackage)) {
      this.addPackageJsonUpdate(targetPackage, {
        version: target.version,
        addToPackageJson: target.addToPackageJson || false,
      });
      return [];
    }

    let migrationConfig: ResolvedMigrationConfiguration;
    try {
      migrationConfig = await this.fetch(targetPackage, targetVersion);
    } catch (e) {
      if (e?.message?.includes('No matching version')) {
        throw new Error(
          `${e.message}\nRun migrate with --to="package1@version1,package2@version2"`
        );
      } else {
        throw e;
      }
    }

    targetVersion = migrationConfig.version;
    if (
      this.collectedVersions[targetPackage] &&
      gte(this.collectedVersions[targetPackage], targetVersion)
    ) {
      return [];
    }
    this.collectedVersions[targetPackage] = targetVersion;

    const { packageJsonUpdates, packageGroupOrder } =
      this.getPackageJsonUpdatesFromMigrationConfig(
        targetPackage,
        targetVersion,
        migrationConfig
      );

    this.addPackageJsonUpdate(targetPackage, {
      version: migrationConfig.version,
      addToPackageJson: target.addToPackageJson || false,
    });

    const shouldCheckUpdates = packageJsonUpdates.some(
      (packageJsonUpdate) =>
        (this.interactive && packageJsonUpdate['x-prompt']) ||
        Object.keys(packageJsonUpdate.requires ?? {}).length
    );

    if (shouldCheckUpdates) {
      return [{ package: targetPackage, updates: packageJsonUpdates }];
    }

    const packageUpdatesToApply = packageJsonUpdates.reduce(
      (m, c) => ({ ...m, ...c.packages }),
      {} as Record<string, PackageJsonUpdateForPackage>
    );
    return (
      await Promise.all(
        Object.entries(packageUpdatesToApply).map(
          ([packageName, packageUpdate]) =>
            this.populatePackageJsonUpdatesAndGetPackagesToCheck(
              packageName,
              packageUpdate
            )
        )
      )
    )
      .filter((pkgs) => pkgs.length)
      .flat()
      .sort(
        (pkgUpdate1, pkgUpdate2) =>
          packageGroupOrder.indexOf(pkgUpdate1.package) -
          packageGroupOrder.indexOf(pkgUpdate2.package)
      );
  }

  private getPackageJsonUpdatesFromMigrationConfig(
    packageName: string,
    targetVersion: string,
    migrationConfig: ResolvedMigrationConfiguration
  ): {
    packageJsonUpdates: PackageJsonUpdates[string][];
    packageGroupOrder: string[];
  } {
    const packageGroup = this.normalizePackageGroup(
      packageName,
      targetVersion,
      migrationConfig.packageGroup
    );

    let packageGroupOrder: string[] = [];
    if (packageGroup.length) {
      packageGroupOrder = packageGroup.map(
        (packageConfig) => packageConfig.package
      );

      setPackageGroupAsPackageJsonUpdate(
        packageGroup,
        targetVersion,
        migrationConfig
      );
    }

    if (
      !migrationConfig.packageJsonUpdates ||
      !this.getPkgVersion(packageName)
    ) {
      return { packageJsonUpdates: [], packageGroupOrder };
    }

    const packageJsonUpdates = this.filterPackageJsonUpdates(
      migrationConfig.packageJsonUpdates,
      packageName,
      targetVersion
    );

    return { packageJsonUpdates, packageGroupOrder };
  }

  private filterPackageJsonUpdates(
    packageJsonUpdates: PackageJsonUpdates,
    packageName: string,
    targetVersion: string
  ): PackageJsonUpdates[string][] {
    const filteredPackageJsonUpdates: PackageJsonUpdates[string][] = [];

    for (const packageJsonUpdate of Object.values(packageJsonUpdates)) {
      if (
        !packageJsonUpdate.packages ||
        this.lte(packageJsonUpdate.version, this.getPkgVersion(packageName)) ||
        this.gt(packageJsonUpdate.version, targetVersion)
      ) {
        continue;
      }

      const { dependencies, devDependencies } = this.packageJson;
      packageJsonUpdate.packages = Object.entries(packageJsonUpdate.packages)
        .filter(
          ([packageName, packageUpdate]) =>
            (!packageUpdate.ifPackageInstalled ||
              this.getPkgVersion(packageUpdate.ifPackageInstalled)) &&
            (packageUpdate.alwaysAddToPackageJson ||
              packageUpdate.addToPackageJson ||
              !!dependencies?.[packageName] ||
              !!devDependencies?.[packageName]) &&
            (!this.collectedVersions[packageName] ||
              this.gt(
                packageUpdate.version,
                this.collectedVersions[packageName]
              ))
        )
        .reduce((acc, [packageName, packageUpdate]) => {
          acc[packageName] = {
            version: packageUpdate.version,
            addToPackageJson: packageUpdate.alwaysAddToPackageJson
              ? 'dependencies'
              : packageUpdate.addToPackageJson || false,
          };
          return acc;
        }, {} as Record<string, PackageJsonUpdateForPackage>);

      if (Object.keys(packageJsonUpdate.packages).length) {
        filteredPackageJsonUpdates.push(packageJsonUpdate);
      }
    }

    return filteredPackageJsonUpdates;
  }

  private addPackageJsonUpdate(
    name: string,
    packageUpdate: PackageJsonUpdateForPackage
  ): void {
    if (
      !this.packageJsonUpdates[name] ||
      this.gt(packageUpdate.version, this.packageJsonUpdates[name].version)
    ) {
      this.packageJsonUpdates[name] = packageUpdate;
    }
  }

  private areRequirementsMet(
    requirements: PackageJsonUpdates[string]['requires'],
    extraPackageUpdatesToCheck?: Record<string, PackageJsonUpdateForPackage>
  ): boolean {
    if (!requirements || !Object.keys(requirements).length) {
      return true;
    }

    return Object.entries(requirements).every(
      ([pkgName, versionRange]) =>
        (this.getPkgVersion(pkgName) &&
          satisfies(this.getPkgVersion(pkgName), versionRange, {
            includePrerelease: true,
          })) ||
        (this.packageJsonUpdates[pkgName]?.version &&
          satisfies(this.packageJsonUpdates[pkgName].version, versionRange, {
            includePrerelease: true,
          })) ||
        (extraPackageUpdatesToCheck?.[pkgName]?.version &&
          satisfies(
            cleanSemver(extraPackageUpdatesToCheck[pkgName].version),
            versionRange,
            { includePrerelease: true }
          ))
    );
  }

  private async runPackageJsonUpdatesConfirmationPrompt(
    confirmationPrompt: string
  ): Promise<boolean> {
    if (!confirmationPrompt) {
      return Promise.resolve(true);
    }

    return await prompt([
      {
        name: 'shouldApply',
        type: 'confirm',
        message: confirmationPrompt,
        initial: true,
      },
    ]).then((a: { shouldApply: boolean }) => a.shouldApply);
  }

  private getPkgVersion(pkg: string): string {
    return this.getInstalledPackageVersion(
      pkg,
      this.installedPkgVersionOverrides
    );
  }

  private normalizePackageGroup(
    packageName: string,
    targetVersion: string,
    packageGroup: PackageGroup
  ): { package: string; version: string }[] {
    // Support Migrating to older versions of Nx
    // Use the packageGroup of the latest version of Nx instead of the one from the target version which could be older.
    if (
      packageName === '@nrwl/workspace' &&
      lt(targetVersion, '14.0.0-beta.0')
    ) {
      packageGroup = {
        '@nrwl/workspace': '*',
        '@nrwl/angular': '*',
        '@nrwl/cypress': '*',
        '@nrwl/devkit': '*',
        '@nrwl/eslint-plugin-nx': '*',
        '@nrwl/express': '*',
        '@nrwl/jest': '*',
        '@nrwl/linter': '*',
        '@nrwl/nest': '*',
        '@nrwl/next': '*',
        '@nrwl/node': '*',
        '@nrwl/nx-plugin': '*',
        '@nrwl/react': '*',
        '@nrwl/storybook': '*',
        '@nrwl/web': '*',
        '@nrwl/js': '*',
        '@nrwl/cli': '*',
        '@nrwl/nx-cloud': 'latest',
        '@nrwl/react-native': '*',
        '@nrwl/detox': '*',
        '@nrwl/expo': '*',
      };
    }

    if (!packageGroup) {
      return [];
    }

    if (!Array.isArray(packageGroup)) {
      return Object.entries(packageGroup).map(([pkg, version]) => {
        if (this.installedPkgVersionOverrides[packageName] && version === '*') {
          this.installedPkgVersionOverrides[pkg] ??=
            this.installedPkgVersionOverrides[packageName];
        }
        return { package: pkg, version };
      });
    }

    return packageGroup.map((packageConfig) => {
      if (this.installedPkgVersionOverrides[packageName]) {
        if (typeof packageConfig === 'string') {
          this.installedPkgVersionOverrides[packageConfig] ??=
            this.installedPkgVersionOverrides[packageName];
        } else if (packageConfig.version === '*') {
          this.installedPkgVersionOverrides[packageConfig.package] ??=
            this.installedPkgVersionOverrides[packageName];
        }
      }

      return typeof packageConfig === 'string'
        ? { package: packageConfig, version: targetVersion }
        : packageConfig;
    });
  }

  private gt(v1: string, v2: string) {
    return gt(normalizeVersion(v1), normalizeVersion(v2));
  }

  private lte(v1: string, v2: string) {
    return lte(normalizeVersion(v1), normalizeVersion(v2));
  }
}

function setPackageGroupAsPackageJsonUpdate(
  packageGroup: { package: string; version: string }[],
  targetVersion: string,
  migrationConfig: ResolvedMigrationConfiguration
) {
  migrationConfig.packageJsonUpdates ??= {};
  migrationConfig.packageJsonUpdates[targetVersion + '--PackageGroup'] = {
    version: targetVersion,
    packages: packageGroup.reduce((acc, packageConfig) => {
      acc[packageConfig.package] = {
        version: packageConfig.version,
        alwaysAddToPackageJson: false,
      };
      return acc;
    }, {}),
  };
}

function normalizeVersionWithTagCheck(version: string) {
  if (version === 'latest' || version === 'next') return version;
  return normalizeVersion(version);
}

function versionOverrides(overrides: string, param: string) {
  const res = {};
  overrides.split(',').forEach((p) => {
    const split = p.lastIndexOf('@');
    if (split === -1 || split === 0) {
      throw new Error(
        `Incorrect '${param}' section. Use --${param}="package@version"`
      );
    }
    const selectedPackage = p.substring(0, split).trim();
    const selectedVersion = p.substring(split + 1).trim();
    if (!selectedPackage || !selectedVersion) {
      throw new Error(
        `Incorrect '${param}' section. Use --${param}="package@version"`
      );
    }
    res[normalizeSlashes(selectedPackage)] =
      normalizeVersionWithTagCheck(selectedVersion);
  });
  return res;
}

function parseTargetPackageAndVersion(args: string) {
  if (!args) {
    throw new Error(
      `Provide the correct package name and version. E.g., my-package@9.0.0.`
    );
  }

  if (args.indexOf('@') > -1) {
    const i = args.lastIndexOf('@');
    if (i === 0) {
      const targetPackage = args.trim();
      const targetVersion = 'latest';
      return { targetPackage, targetVersion };
    } else {
      const targetPackage = args.substring(0, i);
      const maybeVersion = args.substring(i + 1);
      if (!targetPackage || !maybeVersion) {
        throw new Error(
          `Provide the correct package name and version. E.g., my-package@9.0.0.`
        );
      }
      const targetVersion = normalizeVersionWithTagCheck(maybeVersion);
      return { targetPackage, targetVersion };
    }
  } else {
    if (
      args === 'latest' ||
      args === 'next' ||
      valid(args) ||
      args.match(/^\d+(?:\.\d+)?(?:\.\d+)?$/)
    ) {
      const targetVersion = normalizeVersionWithTagCheck(args);
      const targetPackage =
        !['latest', 'next'].includes(args) && lt(targetVersion, '14.0.0-beta.0')
          ? '@nrwl/workspace'
          : 'nx';

      return {
        targetPackage,
        targetVersion,
      };
    } else {
      return {
        targetPackage: args,
        targetVersion: 'latest',
      };
    }
  }
}

type GenerateMigrations = {
  type: 'generateMigrations';
  targetPackage: string;
  targetVersion: string;
  from: { [k: string]: string };
  to: { [k: string]: string };
  interactive?: boolean;
};

type RunMigrations = { type: 'runMigrations'; runMigrations: string };

export function parseMigrationsOptions(options: {
  [k: string]: any;
}): GenerateMigrations | RunMigrations {
  if (options.runMigrations === '') {
    options.runMigrations = 'migrations.json';
  }

  if (!options.runMigrations) {
    const from = options.from
      ? versionOverrides(options.from as string, 'from')
      : {};
    const to = options.to ? versionOverrides(options.to as string, 'to') : {};
    const { targetPackage, targetVersion } = parseTargetPackageAndVersion(
      options['packageAndVersion']
    );
    const interactive = options.interactive;
    return {
      type: 'generateMigrations',
      targetPackage: normalizeSlashes(targetPackage),
      targetVersion,
      from,
      to,
      interactive,
    };
  } else {
    return {
      type: 'runMigrations',
      runMigrations: options.runMigrations as string,
    };
  }
}

function createInstalledPackageVersionsResolver(
  root: string
): MigratorOptions['getInstalledPackageVersion'] {
  const cache: Record<string, string> = {};

  function getInstalledPackageVersion(
    packageName: string,
    overrides: Record<string, string>
  ): string | null {
    try {
      if (overrides[packageName]) {
        return overrides[packageName];
      }

      if (!cache[packageName]) {
        const { packageJson } = readModulePackageJson(packageName, [root]);
        cache[packageName] = packageJson.version;
      }

      return cache[packageName];
    } catch {
      // Support migrating old workspaces without nx package
      if (packageName === 'nx') {
        return getInstalledPackageVersion('@nrwl/workspace', overrides);
      }
      return null;
    }
  }

  return getInstalledPackageVersion;
}

// testing-fetch-start
function createFetcher() {
  const migrationsCache: Record<
    string,
    Promise<ResolvedMigrationConfiguration>
  > = {};
  const resolvedVersionCache: Record<string, Promise<string>> = {};

  function fetchMigrations(
    packageName,
    packageVersion,
    setCache: (packageName: string, packageVersion: string) => void
  ): Promise<ResolvedMigrationConfiguration> {
    const cacheKey = packageName + '-' + packageVersion;
    return Promise.resolve(resolvedVersionCache[cacheKey])
      .then((cachedResolvedVersion) => {
        if (cachedResolvedVersion) {
          return cachedResolvedVersion;
        }

        resolvedVersionCache[cacheKey] = resolvePackageVersionUsingRegistry(
          packageName,
          packageVersion
        );
        return resolvedVersionCache[cacheKey];
      })
      .then((resolvedVersion) => {
        if (
          resolvedVersion !== packageVersion &&
          migrationsCache[`${packageName}-${resolvedVersion}`]
        ) {
          return migrationsCache[`${packageName}-${resolvedVersion}`];
        }
        setCache(packageName, resolvedVersion);
        return getPackageMigrationsUsingRegistry(packageName, resolvedVersion);
      })
      .catch(() => {
        logger.info(`Fetching ${packageName}@${packageVersion}`);

        return getPackageMigrationsUsingInstall(packageName, packageVersion);
      });
  }

  return function nxMigrateFetcher(
    packageName: string,
    packageVersion: string
  ): Promise<ResolvedMigrationConfiguration> {
    if (migrationsCache[`${packageName}-${packageVersion}`]) {
      return migrationsCache[`${packageName}-${packageVersion}`];
    }

    let resolvedVersion: string = packageVersion;
    let migrations: Promise<ResolvedMigrationConfiguration>;

    function setCache(packageName: string, packageVersion: string) {
      migrationsCache[packageName + '-' + packageVersion] = migrations;
    }

    migrations = fetchMigrations(packageName, packageVersion, setCache).then(
      (result) => {
        if (result.schematics) {
          result.generators = result.schematics;
          delete result.schematics;
        }
        resolvedVersion = result.version;
        return result;
      }
    );

    setCache(packageName, packageVersion);

    return migrations;
  };
}

// testing-fetch-end

async function getPackageMigrationsUsingRegistry(
  packageName: string,
  packageVersion: string
): Promise<ResolvedMigrationConfiguration> {
  // check if there are migrations in the packages by looking at the
  // registry directly
  const migrationsConfig = await getPackageMigrationsConfigFromRegistry(
    packageName,
    packageVersion
  );

  if (!migrationsConfig) {
    return {
      version: packageVersion,
    };
  }

  if (!migrationsConfig.migrations) {
    return {
      version: packageVersion,
      packageGroup: migrationsConfig.packageGroup,
    };
  }

  logger.info(`Fetching ${packageName}@${packageVersion}`);

  // try to obtain the migrations from the registry directly
  return await downloadPackageMigrationsFromRegistry(
    packageName,
    packageVersion,
    migrationsConfig
  );
}

async function getPackageMigrationsConfigFromRegistry(
  packageName: string,
  packageVersion: string
): Promise<NxMigrationsConfiguration> {
  const result = await packageRegistryView(
    packageName,
    packageVersion,
    'nx-migrations ng-update --json'
  );

  if (!result) {
    return null;
  }

  return readNxMigrateConfig(JSON.parse(result));
}

async function downloadPackageMigrationsFromRegistry(
  packageName: string,
  packageVersion: string,
  { migrations: migrationsFilePath, packageGroup }: NxMigrationsConfiguration
): Promise<ResolvedMigrationConfiguration> {
  const { dir, cleanup } = createTempNpmDirectory();

  let result: ResolvedMigrationConfiguration;

  try {
    const { tarballPath } = await packageRegistryPack(
      dir,
      packageName,
      packageVersion
    );

    const migrations = await extractFileFromTarball(
      join(dir, tarballPath),
      join('package', migrationsFilePath),
      join(dir, migrationsFilePath)
    ).then((path) => readJsonFile<MigrationsJson>(path));

    result = { ...migrations, packageGroup, version: packageVersion };
  } catch {
    throw new Error(
      `Failed to find migrations file "${migrationsFilePath}" in package "${packageName}@${packageVersion}".`
    );
  } finally {
    await cleanup();
  }

  return result;
}

async function getPackageMigrationsUsingInstall(
  packageName: string,
  packageVersion: string
): Promise<ResolvedMigrationConfiguration> {
  const { dir, cleanup } = createTempNpmDirectory();

  let result: ResolvedMigrationConfiguration;

  try {
    const pmc = getPackageManagerCommand(detectPackageManager(dir));

    await execAsync(`${pmc.add} ${packageName}@${packageVersion}`, {
      cwd: dir,
    });

    const {
      migrations: migrationsFilePath,
      packageGroup,
      packageJson,
    } = readPackageMigrationConfig(packageName, dir);

    let migrations: MigrationsJson = undefined;
    if (migrationsFilePath) {
      migrations = readJsonFile<MigrationsJson>(migrationsFilePath);
    }

    result = { ...migrations, packageGroup, version: packageJson.version };
  } finally {
    await cleanup();
  }

  return result;
}

interface PackageMigrationConfig extends NxMigrationsConfiguration {
  packageJson: PackageJson;
}

function readPackageMigrationConfig(
  packageName: string,
  dir: string
): PackageMigrationConfig {
  const { path: packageJsonPath, packageJson: json } = readModulePackageJson(
    packageName,
    [dir]
  );

  const migrationConfigOrFile = json['nx-migrations'] || json['ng-update'];

  if (!migrationConfigOrFile) {
    return { packageJson: json, migrations: null, packageGroup: [] };
  }

  const migrationsConfig =
    typeof migrationConfigOrFile === 'string'
      ? {
          migrations: migrationConfigOrFile,
          packageGroup: [],
        }
      : migrationConfigOrFile;

  try {
    const migrationFile = require.resolve(migrationsConfig.migrations, {
      paths: [dirname(packageJsonPath)],
    });

    return {
      packageJson: json,
      migrations: migrationFile,
      packageGroup: migrationsConfig.packageGroup,
    };
  } catch {
    return {
      packageJson: json,
      migrations: null,
      packageGroup: migrationsConfig.packageGroup,
    };
  }
}

function createMigrationsFile(
  root: string,
  migrations: {
    package: string;
    name: string;
  }[]
) {
  writeJsonFile(join(root, 'migrations.json'), { migrations });
}

function updatePackageJson(
  root: string,
  updatedPackages: Record<string, PackageJsonUpdateForPackage>
) {
  const packageJsonPath = join(root, 'package.json');
  const parseOptions: JsonReadOptions = {};
  const json = readJsonFile(packageJsonPath, parseOptions);

  Object.keys(updatedPackages).forEach((p) => {
    if (json.devDependencies?.[p]) {
      json.devDependencies[p] = updatedPackages[p].version;
      return;
    }

    if (json.dependencies?.[p]) {
      json.dependencies[p] = updatedPackages[p].version;
      return;
    }

    const dependencyType = updatedPackages[p].addToPackageJson;
    if (typeof dependencyType === 'string') {
      json[dependencyType] ??= {};
      json[dependencyType][p] = updatedPackages[p].version;
    }
  });

  writeJsonFile(packageJsonPath, json, {
    appendNewLine: parseOptions.endsWithNewline,
  });
}

async function isMigratingToNewMajor(from: string, to: string) {
  from = normalizeVersion(from);
  to = ['latest', 'next'].includes(to) ? to : normalizeVersion(to);
  if (!valid(from)) {
    from = await resolvePackageVersionUsingRegistry('nx', from);
  }
  if (!valid(to)) {
    to = await resolvePackageVersionUsingRegistry('nx', to);
  }
  return major(from) < major(to);
}

function readNxVersion(packageJson: PackageJson) {
  return (
    packageJson?.devDependencies?.['nx'] ??
    packageJson?.dependencies?.['nx'] ??
    packageJson?.devDependencies?.['@nrwl/workspace'] ??
    packageJson?.dependencies?.['@nrwl/workspace']
  );
}

async function generateMigrationsJsonAndUpdatePackageJson(
  root: string,
  opts: GenerateMigrations
) {
  const pmc = getPackageManagerCommand();
  try {
    let originalPackageJson = readJsonFile<PackageJson>(
      join(root, 'package.json')
    );
    const from = readNxVersion(originalPackageJson);

    try {
      if (
        ['nx', '@nrwl/workspace'].includes(opts.targetPackage) &&
        (await isMigratingToNewMajor(from, opts.targetVersion))
      ) {
        const useCloud = await connectToNxCloudCommand(
          messages.getPromptMessage('nxCloudMigration')
        );
        await recordStat({
          command: 'migrate',
          nxVersion,
          useCloud,
          meta: messages.codeOfSelectedPromptMessage('nxCloudMigration'),
        });
        originalPackageJson = readJsonFile<PackageJson>(
          join(root, 'package.json')
        );
      }
    } catch {
      // The above code is to remind folks when updating to a new major and not currently using Nx cloud.
      // If for some reason it fails, it shouldn't affect the overall migration process
    }

    logger.info(`Fetching meta data about packages.`);
    logger.info(`It may take a few minutes.`);

    const migrator = new Migrator({
      packageJson: originalPackageJson,
      getInstalledPackageVersion: createInstalledPackageVersionsResolver(root),
      fetch: createFetcher(),
      from: opts.from,
      to: opts.to,
      interactive: opts.interactive,
    });

    const { migrations, packageJson } = await migrator.updatePackageJson(
      opts.targetPackage,
      opts.targetVersion
    );

    updatePackageJson(root, packageJson);

    if (migrations.length > 0) {
      createMigrationsFile(root, [
        ...addSplitConfigurationMigrationIfAvailable(from, packageJson),
        ...migrations,
      ] as any);
    }

    output.success({
      title: `The migrate command has run successfully.`,
      bodyLines: [
        `- Package.json has been updated.`,
        migrations.length > 0
          ? `- Migrations.json has been generated.`
          : `- There are no migrations to run, so migrations.json has not been created.`,
      ],
    });

    output.log({
      title: 'Next steps:',
      bodyLines: [
        `- Make sure package.json changes make sense and then run '${pmc.install}',`,
        ...(migrations.length > 0
          ? [`- Run '${pmc.exec} nx migrate --run-migrations'`]
          : []),
        `- To learn more go to https://nx.dev/core-features/automate-updating-dependencies`,
        ...(showConnectToCloudMessage()
          ? [
              `- You may run '${pmc.run(
                'nx',
                'connect-to-nx-cloud'
              )}' to get faster builds, GitHub integration, and more. Check out https://nx.app`,
            ]
          : []),
      ],
    });
  } catch (e) {
    output.error({
      title: `The migrate command failed.`,
    });
    throw e;
  }
}

function addSplitConfigurationMigrationIfAvailable(
  from: string,
  packageJson: any
) {
  if (!packageJson['@nrwl/workspace']) return [];

  if (
    gte(packageJson['@nrwl/workspace'].version, '15.7.0') &&
    lt(from, '15.7.0')
  ) {
    return [
      {
        version: '15.7.0-beta.0',
        description:
          'Spilt global configuration files into individual project.json files. This migration has been added automatically to the beginning of your migration set to retroactively make them work with the new version of Nx.',
        cli: 'nx',
        implementation:
          './src/migrations/update-15-7-0/split-configuration-into-project-json-files',
        package: '@nrwl/workspace',
        name: '15-7-0-split-configuration-into-project-json-files',
      },
    ];
  } else {
    return [];
  }
}

function showConnectToCloudMessage() {
  try {
    const nxJson = readJsonFile<NxJsonConfiguration>('nx.json');
    const defaultRunnerIsUsed =
      !nxJson.tasksRunnerOptions ||
      Object.values(nxJson.tasksRunnerOptions).find(
        (r: any) =>
          r.runner == '@nrwl/workspace/tasks-runners/default' ||
          r.runner == 'nx/tasks-runners/default'
      );
    return !!defaultRunnerIsUsed;
  } catch {
    return false;
  }
}

function runInstall() {
  const pmCommands = getPackageManagerCommand();
  output.log({
    title: `Running '${pmCommands.install}' to make sure necessary packages are installed`,
  });
  execSync(pmCommands.install, { stdio: [0, 1, 2] });
}

export async function executeMigrations(
  root: string,
  migrations: {
    package: string;
    name: string;
    description?: string;
    version: string;
    cli?: 'nx' | 'angular';
  }[],
  isVerbose: boolean,
  shouldCreateCommits: boolean,
  commitPrefix: string
) {
  const depsBeforeMigrations = getStringifiedPackageJsonDeps(root);

  const migrationsWithNoChanges: typeof migrations = [];

  let ngCliAdapter: typeof import('../adapter/ngcli-adapter');
  if (migrations.some((m) => m.cli !== 'nx')) {
    ngCliAdapter = await import('../adapter/ngcli-adapter');
    require('../adapter/compat');
  }

  for (const m of migrations) {
    try {
      if (m.cli === 'nx') {
        const changes = await runNxMigration(root, m.package, m.name);

        if (changes.length < 1) {
          migrationsWithNoChanges.push(m);
          // If no changes are made, continue on without printing anything
          continue;
        }

        logger.info(`Ran ${m.name} from ${m.package}`);
        logger.info(`  ${m.description}\n`);
        printChanges(changes, '  ');
      } else {
        const { madeChanges, loggingQueue } = await ngCliAdapter.runMigration(
          root,
          m.package,
          m.name,
          isVerbose
        );

        if (!madeChanges) {
          migrationsWithNoChanges.push(m);
          // If no changes are made, continue on without printing anything
          continue;
        }

        logger.info(`Ran ${m.name} from ${m.package}`);
        logger.info(`  ${m.description}\n`);
        loggingQueue.forEach((log) => logger.info('  ' + log));
      }

      if (shouldCreateCommits) {
        const commitMessage = `${commitPrefix}${m.name}`;
        try {
          const committedSha = commitChanges(commitMessage);

          if (committedSha) {
            logger.info(
              chalk.dim(`- Commit created for changes: ${committedSha}`)
            );
          } else {
            logger.info(
              chalk.red(
                `- A commit could not be created/retrieved for an unknown reason`
              )
            );
          }
        } catch (e) {
          logger.info(chalk.red(`- ${e.message}`));
        }
      }
      logger.info(`---------------------------------------------------------`);
    } catch (e) {
      output.error({
        title: `Failed to run ${m.name} from ${m.package}. This workspace is NOT up to date!`,
      });
      throw e;
    }
  }

  const depsAfterMigrations = getStringifiedPackageJsonDeps(root);
  if (depsBeforeMigrations !== depsAfterMigrations) {
    runInstall();
  }
  return migrationsWithNoChanges;
}

async function runMigrations(
  root: string,
  opts: { runMigrations: string },
  isVerbose: boolean,
  shouldCreateCommits = false,
  commitPrefix: string
) {
  if (!process.env.NX_MIGRATE_SKIP_INSTALL) {
    runInstall();
  }

  output.log({
    title:
      `Running migrations from '${opts.runMigrations}'` +
      (shouldCreateCommits ? ', with each applied in a dedicated commit' : ''),
  });

  const migrations: {
    package: string;
    name: string;
    version: string;
    cli?: 'nx' | 'angular';
  }[] = readJsonFile(join(root, opts.runMigrations)).migrations;

  const migrationsWithNoChanges = await executeMigrations(
    root,
    migrations,
    isVerbose,
    shouldCreateCommits,
    commitPrefix
  );

  if (migrationsWithNoChanges.length < migrations.length) {
    output.success({
      title: `Successfully finished running migrations from '${opts.runMigrations}'. This workspace is up to date!`,
    });
  } else {
    output.success({
      title: `No changes were made from running '${opts.runMigrations}'. This workspace is up to date!`,
    });
  }
}

function getStringifiedPackageJsonDeps(root: string): string {
  const { dependencies, devDependencies } = readJsonFile<PackageJson>(
    join(root, 'package.json')
  );

  return JSON.stringify([dependencies, devDependencies]);
}

function commitChanges(commitMessage: string): string | null {
  try {
    execSync('git add -A', { encoding: 'utf8', stdio: 'pipe' });
    execSync('git commit --no-verify -F -', {
      encoding: 'utf8',
      stdio: 'pipe',
      input: commitMessage,
    });
  } catch (err) {
    throw new Error(`Error committing changes:\n${err.stderr}`);
  }

  return getLatestCommitSha();
}

function getLatestCommitSha(): string | null {
  try {
    return execSync('git rev-parse HEAD', {
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  } catch {
    return null;
  }
}

async function runNxMigration(root: string, packageName: string, name: string) {
  const collectionPath = readPackageMigrationConfig(
    packageName,
    root
  ).migrations;

  const collection = readJsonFile<MigrationsJson>(collectionPath);
  const g = collection.generators || collection.schematics;
  if (!g[name]) {
    const source = collection.generators ? 'generators' : 'schematics';
    throw new Error(
      `Unable to determine implementation path for "${collectionPath}:${name}" using collection.${source}`
    );
  }
  const implRelativePath = g[name].implementation || g[name].factory;

  let implPath: string;

  try {
    implPath = require.resolve(implRelativePath, {
      paths: [dirname(collectionPath)],
    });
  } catch (e) {
    // workaround for a bug in node 12
    implPath = require.resolve(
      `${dirname(collectionPath)}/${implRelativePath}`
    );
  }

  const fn = require(implPath).default;
  const host = new FsTree(root, false);
  await fn(host, {});
  const changes = host.listChanges();
  flushChanges(root, changes);
  return changes;
}

export async function migrate(root: string, args: { [k: string]: any }) {
  if (args['verbose']) {
    process.env.NX_VERBOSE_LOGGING = 'true';
  }

  return handleErrors(process.env.NX_VERBOSE_LOGGING === 'true', async () => {
    const opts = parseMigrationsOptions(args);
    if (opts.type === 'generateMigrations') {
      await generateMigrationsJsonAndUpdatePackageJson(root, opts);
    } else {
      await runMigrations(
        root,
        opts,
        args['verbose'],
        args['createCommits'],
        args['commitPrefix']
      );
    }
  });
}
