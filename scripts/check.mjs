#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildTargetTree, incompleteSelectableTargets, parseInfoRecords, parseKconfigTree, parsePackageInfo,
  resolveTargetSelectors, targetBuildContract,
} from './lib.mjs';
import { buildKconfigRelations } from './kconfig-relations.mjs';
import { buildProbeConfig, verifyProbeConfig } from './verify-target-contracts.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = join(ROOT, 'tests', 'fixture');
const targets = parseInfoRecords(readFileSync(join(fixture, 'targetinfo'), 'utf8'));
const packages = parsePackageInfo(readFileSync(join(fixture, 'packageinfo'), 'utf8'));
const menu = parseKconfigTree(fixture);
const relations = buildKconfigRelations(menu.options, packages, menu.choices);
const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'catalog.yml'), 'utf8');
const translationWorkflow = readFileSync(join(ROOT, '.github', 'workflows', 'translate.yml'), 'utf8');
const discover = readFileSync(join(ROOT, 'scripts', 'discover.mjs'), 'utf8');
const metadata = readFileSync(join(ROOT, 'scripts', 'prepare-metadata.sh'), 'utf8');
const stageRunner = readFileSync(join(ROOT, 'scripts', 'run-stage.sh'), 'utf8');
const attemptWriter = readFileSync(join(ROOT, 'scripts', 'write-attempt.mjs'), 'utf8');
const collector = readFileSync(join(ROOT, 'scripts', 'collect-results.mjs'), 'utf8');
const release = readFileSync(join(ROOT, 'scripts', 'publish-release.sh'), 'utf8');
const policy = JSON.parse(readFileSync(join(ROOT, 'catalog.config.json'), 'utf8'));
const generator = readFileSync(join(ROOT, 'scripts', 'generate-catalog.mjs'), 'utf8');
const validator = readFileSync(join(ROOT, 'scripts', 'verify-target-contracts.mjs'), 'utf8');
const library = readFileSync(join(ROOT, 'scripts', 'lib.mjs'), 'utf8');
const menuI18n = JSON.parse(readFileSync(join(ROOT, 'translations', 'menu-i18n.json'), 'utf8'));
const translations = JSON.parse(readFileSync(join(ROOT, 'translations', 'zh-CN.json'), 'utf8'));
const autoTranslator = readFileSync(join(ROOT, 'scripts', 'translate-catalog.mjs'), 'utf8');
const translationPlan = readFileSync(join(ROOT, 'scripts', 'translation-plan.mjs'), 'utf8');
const failures = [];
const unsafePlainRunContinuation = /^\s*run:\s+[^\n]*\\\s*$/m.test(workflow);
const x86Target = targets.find((item) => item.id === 'x86/64');
const filogicTarget = targets.find((item) => item.id === 'mediatek/filogic');
const abstractTarget = targets.find((item) => item.id === 'abstract-board');
const unavailableTarget = targets.find((item) => item.id === 'unavailable-board');
const fixtureSymbols = new Set(menu.options.map((item) => item.symbol));
for (const target of targets) {
  target.contract = targetBuildContract(target, fixtureSymbols);
  target.targetSelector = target.contract.targetSelector || '';
  const profileContracts = new Map((target.contract.profileContracts || []).map((item) => [item.id, item]));
  for (const profile of target.profiles) {
    const contract = profileContracts.get(profile.id);
    profile.selector = contract?.selector || '';
    profile.selectable = contract?.selectable !== false;
  }
}
const fixtureTargetTree = buildTargetTree(targets.filter((item) => item.contract.selectable), menu.options);
const x86System = fixtureTargetTree.find((item) => item.value === 'x86');
const x8664 = x86System?.children.find((item) => item.value === '64');
const mediatekSystem = fixtureTargetTree.find((item) => item.value === 'mediatek');
const filogic = mediatekSystem?.children.find((item) => item.value === 'filogic');
if (targets.length !== 4 || targets.reduce((n, item) => n + item.profiles.length, 0) !== 4 ||
    x86Target?.arch !== 'x86_64' || filogicTarget?.arch !== 'aarch64' ||
    abstractTarget?.profiles.length !== 0 || unavailableTarget?.profiles.length !== 1 ||
    targetBuildContract(abstractTarget).kind !== 'abstract' ||
    targetBuildContract(unavailableTarget).kind !== 'unavailable' ||
    incompleteSelectableTargets(targets).map((item) => item.id).join(',') !== 'unavailable-board') {
  failures.push('targetinfo/build contract');
}
if (x86System?.labelEn !== 'x86' || x8664?.labelEn !== 'x86_64' ||
    x8664?.children.map((item) => item.labelEn).join(',') !== 'Generic x86/64,QEMU Q35' ||
    mediatekSystem?.labelEn !== 'MediaTek ARM' || filogic?.labelEn !== 'Filogic 8x0 (MT798x)' ||
    new Set(fixtureTargetTree.map((item) => item.value)).size !== fixtureTargetTree.length) {
  failures.push('official Target/System/Subtarget/Profile hierarchy');
}
const aliasTargets = parseInfoRecords('Target: x86/64\nTarget-Board: x86\nTarget-Subtarget: 64\n' +
  'Target-Arch: x86_64\nTarget-Arch-Packages: x86_64\n' +
  'Target-Profile: DEVICE_demo\nTarget-Profile-Name: Alias Router (Demo Router)\n' +
  'Target-Profile: DEVICE_demo\nTarget-Profile-Name: Demo Router\n');
if (aliasTargets[0]?.profiles.length !== 1 || aliasTargets[0]?.profiles[0]?.name !== 'Demo Router' ||
    aliasTargets[0]?.profiles[0]?.aliases?.join(',') !== 'Alias Router (Demo Router)') {
  failures.push('Target Profile alias deduplication');
}
const legacyRecords = parseInfoRecords(`Target: ath25\nTarget-Board: ath25\nTarget-Arch: mips_24kc\n` +
  'Target-Arch-Packages: mips_24kc\nTarget-Profile: Default\n' +
  'Target-Profile-Packages: -dnsmasq +kmod-ath9k\n');
const legacyTarget = legacyRecords[0];
const legacyProfile = legacyTarget?.profiles[0];
const legacySymbols = new Set(['TARGET_ath25', 'TARGET_ath25_Default']);
const legacySelectors = resolveTargetSelectors(legacyTarget, legacyProfile, legacySymbols);
const legacyProbe = buildProbeConfig(legacyTarget, legacyProfile, legacySelectors);
const legacyContract = targetBuildContract(legacyTarget, legacySymbols);
if (legacyTarget?.subtarget || legacyTarget?.hasSubtarget ||
    legacyProfile?.packagesAdd?.join(',') !== 'kmod-ath9k' ||
    legacyProfile?.packagesRemove?.join(',') !== 'dnsmasq' ||
    !legacyContract.selectable || legacySelectors.target !== 'TARGET_ath25' ||
    legacySelectors.profile !== 'TARGET_ath25_Default' || /PACKAGE_-dnsmasq/.test(legacyProbe) ||
    /TARGET_ath25_generic/.test(legacyProbe)) {
  failures.push('legacy target/negative package probe');
}
const probeProfile = x86Target?.profiles[0];
const probeSelectors = resolveTargetSelectors(x86Target, probeProfile);
const probeFixture = buildProbeConfig(x86Target, probeProfile, probeSelectors);
if (!probeFixture.includes('CONFIG_TARGET_x86=y') ||
    !verifyProbeConfig(probeFixture, x86Target, probeProfile, probeSelectors).valid ||
    verifyProbeConfig(probeFixture.replace(`CONFIG_${probeSelectors.profile}=y`,
      `# CONFIG_${probeSelectors.profile} is not set`), x86Target, probeProfile, probeSelectors).valid) {
  failures.push('Target/Profile Kconfig probe contract');
}
if (packages.length !== 2 || packages[0].category !== 'LuCI' ||
    packages[0].description !== 'Demonstration web interface package' ||
    packages[0].conflicts.join(',') !== 'kmod-demo') failures.push('packageinfo');
const demo = menu.options.find((item) => item.symbol === 'PACKAGE_luci-app-demo');
const luci = menu.options.find((item) => item.symbol === 'PACKAGE_luci');
const demoExtra = menu.options.find((item) => item.symbol === 'PACKAGE_luci-app-demo-extra');
const image = menu.options.find((item) => item.symbol === 'TARGET_IMAGES_GZIP');
if (!demo || demo.type !== 'tristate' || !demo.depends.includes('TARGET_x86') ||
    demo.depends.some((item) => item.includes('sentence remains help')) ||
    !demo.help?.includes('if the application is enabled') ||
    !demo.help?.includes('menu, endmenu and source')) failures.push('help/tristate/dependency');
if (!luci || luci.kind !== 'menuconfig' || demo?.parent !== luci.symbol ||
    demoExtra?.parent !== demo?.symbol) failures.push('implicit menuconfig hierarchy');
if (!image || image.path[0] !== 'Target Images') failures.push('menu path');
if (menu.choices.length !== 1 || !menu.options.some((item) => item.choice)) failures.push('choice');
const demoRelations = relations.records.find((item) => item.package === 'luci-app-demo');
if (!demoRelations || demoRelations.states.join(',') !== 'n,m,y' ||
    !demoRelations.kconfig.depends.includes('PACKAGE_luci') ||
    !demoRelations.kconfig.selects.includes('PACKAGE_luci-base') ||
    !demoRelations.dependencyPackages.includes('luci-base') ||
    !demoRelations.conflicts.includes('kmod-demo') ||
    !relations.validation.structurallyValid ||
    !relations.validation.unresolvedKconfig.some((item) => item.symbol === 'PACKAGE_luci-app-demo')) {
  failures.push('Kconfig/package relationship graph');
}
if (!workflow.includes('scripts/prepare-metadata.sh') ||
    !workflow.includes('id: metadata') ||
    !workflow.includes('run-stage.sh" metadata') ||
    workflow.includes('id: defconfig') ||
    workflow.includes('max-parallel:') ||
    workflow.includes('apt-get') ||
    !workflow.includes('fail-fast: false') ||
    !workflow.includes("if: needs.generate.result == 'success'") ||
    !workflow.includes('scripts/write-attempt.mjs') ||
    !workflow.includes('scripts/run-stage.sh') ||
    !workflow.includes('pattern: "*-catalog-*"') ||
    !workflow.includes('attempts/*--SUMMARY.txt') ||
    !workflow.includes('dist/*.contract.json') ||
    !workflow.includes('retention-days: 14') ||
    !workflow.includes('actions/upload-artifact@v7') ||
    !workflow.includes('actions/download-artifact@v8') ||
    workflow.includes('models: read') ||
    !workflow.includes('01 · Discover / 发现源码分支') ||
    !workflow.includes('matrix.jobName') ||
    !workflow.includes('matrix.artifactPrefix') ||
    !workflow.includes('publish-order') ||
    !workflow.includes('Upload publish diagnostic') ||
    !workflow.includes('scripts/collect-results.mjs') ||
    !workflow.includes('verify-target-contracts.mjs') ||
    !workflow.includes('KCONFIG_CONTRACT_OUTCOME') ||
    !workflow.includes('run: bash scripts/run-stage.sh index node scripts/build-index.mjs dist dist/index.json previous/index.json current-attempts') ||
    unsafePlainRunContinuation) failures.push('workflow resilience');
if (!discover.includes("'openwrt-18.06', 'openwrt-19.07'") ||
    !discover.includes('metadataCompat') ||
    !metadata.includes('touch staging_dir/host/.prereq-build') ||
    !metadata.includes('make prepare-tmpinfo FORCE=1') ||
    metadata.includes('make defconfig')) failures.push('legacy metadata compatibility');
if (!stageRunner.includes('Source ID:') ||
    !stageRunner.includes('Upstream commit:') ||
    !stageRunner.includes('CATALOG_ARTIFACT_NAME') ||
    !stageRunner.includes('CATALOG_ORDER') ||
    !stageRunner.includes('last 40 relevant lines') ||
    !attemptWriter.includes('--SUMMARY.txt') ||
    !attemptWriter.includes("['metadata', process.env.METADATA_OUTCOME]") ||
    !attemptWriter.includes("['kconfig-contract', process.env.KCONFIG_CONTRACT_OUTCOME]") ||
    attemptWriter.includes('DEFCONFIG_OUTCOME') ||
    !attemptWriter.includes('failureLog') ||
    !attemptWriter.includes('orderText') ||
    !collector.includes('publish-inputs.json') ||
    !collector.includes('publishState') ||
    !collector.includes('translation-retry-queue.json') ||
    !collector.includes('target contract') ||
    !collector.includes('.contract.json') ||
    !collector.includes('Kconfig probe quarantine ratio') ||
    !collector.includes('.relations.json') ||
    !collector.includes('last-good') ||
    !collector.includes('complete=${complete}') ||
    release.includes('gh release delete') ||
    !release.includes('.relations.json') ||
    !release.includes('gh release upload') ||
    !release.includes('--clobber')) failures.push('diagnostic identity');
if (policy.sources.length !== 4 || policy.sources[0].id !== 'ImmortalWrt' ||
    policy.sources[0].branches.join(',') !==
      'openwrt-21.02,openwrt-23.05,openwrt-24.10,openwrt-25.12') failures.push('stable branch policy');
const openwrt = policy.sources.find((item) => item.id === 'OpenWrt');
if (openwrt?.branches !== 'all' ||
    openwrt.exclude.join(',') !== 'lede-17.01,pcs-standalone-back,master') failures.push('OpenWrt branch policy');
if (!policy.sources.some((item) => item.id === 'lede' && item.label === 'Lean LEDE')) failures.push('LEDE source policy');
if (!policy.sources.some((item) => item.id === 'hanwckf' &&
    item.repo === 'hanwckf/immortalwrt-mt798x' &&
    item.branches.join(',') === 'openwrt-21.02' && item.legacy === true)) {
  failures.push('hanwckf legacy source policy');
}
if (!generator.includes("option.path[0] !== 'Target Devices'") ||
    !generator.includes('targetBuildContract') ||
    !generator.includes('profile.boardSelector') ||
    !generator.includes('selectableTargets') ||
    !generator.includes('.contract.json') ||
    !generator.includes('menu: compactMenu') ||
    !generator.includes('targetSelectors') ||
    !generator.includes('targetTree') ||
    !generator.includes('pollutedDependencies') ||
    !generator.includes('menuI18n') ||
    !generator.includes('promptZh') ||
    !generator.includes('conflicts') ||
    !generator.includes('buildKconfigRelations') ||
    !generator.includes('.relations.json') ||
    !generator.includes('.translations.json') ||
    generator.includes('\n  packages,\n')) failures.push('compact payload');
if (!library.includes('hasSubtarget') || !library.includes('resolveTargetSelectors') ||
    !library.includes('boardNames') || !validator.includes('boardSelector') ||
    !library.includes('buildTargetTree') || !library.includes('systemName') ||
    library.includes("subtarget = 'generic'") || !generator.includes('kconfigSymbols') ||
    !validator.includes('quarantined') || !validator.includes('quarantineGeneratedProfiles') ||
    validator.includes('requiredPackages') ||
    validator.includes('CONFIG_PACKAGE_${name}')) failures.push('Kconfig selector/package semantics');
const requiredLanguages = ['zh-CN', 'zh-TW', 'ru', 'es', 'pt', 'ja', 'ko', 'de', 'fr', 'vi'];
if (!['Top level', 'General settings', 'Global build settings', 'LuCI'].every((label) =>
  requiredLanguages.every((lang) => menuI18n[label]?.[lang]))) failures.push('menu i18n');
if (translations.policy?.languages?.join(',') !== 'en,zh-CN,zh-TW,ru,es,pt,ja,ko,de,fr,vi' ||
    !translations.entries?.['PACKAGE_luci-app-samba4']?.usageZh) failures.push('English/Chinese translations');
if (!translations.entries?.['PACKAGE_luci-app-samba4']?.usageI18n?.['zh-TW'] ||
    !translations.entries?.['PACKAGE_luci-app-samba4']?.usageI18n?.de) {
  failures.push('curated 11-language translations');
}
if (!autoTranslator.includes('i18n-cache.json') ||
    autoTranslator.includes('models.github.ai') ||
    !autoTranslator.includes('api.cognitive.microsofttranslator.com') ||
    !autoTranslator.includes("process.env.TRANSLATION_PROVIDER || 'argos'") ||
    !autoTranslator.includes('translate-argos.py') ||
    !autoTranslator.includes("process.once('SIGTERM'") ||
    !autoTranslator.includes('Translation cancelled before catalog-data publish') ||
    !autoTranslator.includes("rotationLanguages = ['ru', 'es', 'pt', 'ja', 'ko', 'de', 'fr', 'vi']") ||
    !autoTranslator.includes("frozenLanguages = ['zh-TW']") ||
    !autoTranslator.includes("state.phase = 'zh-CN-usage'") ||
    !autoTranslator.includes('TRANSLATE_CHAR_BUDGET') ||
    !autoTranslator.includes('TRANSLATE_BATCH_NUMBER') ||
    !autoTranslator.includes('batchCount') ||
    !autoTranslator.includes('TRANSLATE_MAX_ITEMS must be an integer from 100 to 5000') ||
    !autoTranslator.includes('Batch incomplete: translated') ||
    !autoTranslator.includes('translation-retry-queue.json') ||
    !autoTranslator.includes('translation-state.json') ||
    !autoTranslator.includes('uniqueDescriptionPendingByLanguage') ||
    !translationWorkflow.includes('translation_provider:') ||
    !translationWorkflow.includes('translate_batch_size:') ||
    !translationWorkflow.includes('translate_batch_count:') ||
    !translationWorkflow.includes('translate_publish_mode:') ||
    !translationWorkflow.includes('scripts/requirements-argos.txt') ||
    !translationWorkflow.includes('scripts/resolve-translation-provider.mjs') ||
    !translationWorkflow.includes('scripts/translation-plan.mjs') ||
    !translationWorkflow.includes('scripts/translate-catalog.mjs') ||
    !translationWorkflow.includes('TRANSLATE_MAX_ITEMS: ${{ steps.plan.outputs.batch_size }}') ||
    !translationWorkflow.includes('TRANSLATE_BATCH_COUNT: ${{ steps.plan.outputs.batch_count }}') ||
    !translationWorkflow.includes('ARGOS_TIME_BUDGET_SECONDS: ${{ steps.plan.outputs.per_batch_time_budget_seconds }}') ||
    !translationWorkflow.includes('TRANSLATE_BATCH_NUMBER="$batch"') ||
    !translationWorkflow.includes('publish_mode="${{ steps.plan.outputs.publish_mode }}"') ||
    !translationWorkflow.includes('git -C dist push origin HEAD:catalog-data') ||
    !translationWorkflow.includes('Translate with live progress') ||
    !translationWorkflow.includes('timeout-minutes: 60') ||
    !translationWorkflow.includes('actions/setup-python@v6') ||
    !translationWorkflow.includes('actions/cache@v5') ||
    !translationWorkflow.includes('$RUNNER_TEMP/translation-run-started') ||
    translationWorkflow.includes('dist/.translation-run-started') ||
    !translationPlan.includes('TRANSLATE_TOTAL_ITEM_LIMIT || 5000') ||
    !translationPlan.includes('TRANSLATE_TOTAL_TIME_BUDGET_SECONDS || 3000') ||
    !translationPlan.includes('perBatchTimeBudgetSeconds') ||
    !translationPlan.includes("publishMode = env.TRANSLATE_PUBLISH_MODE || 'each-batch'") ||
    !translationWorkflow.includes('dist/translation-state.json') ||
    !translationWorkflow.includes('workflow_run:') ||
    !translationWorkflow.includes("github.event.workflow_run.event == 'schedule'") ||
    workflow.includes('scripts/translate-catalog.mjs')) failures.push('manual translation automation');
if (failures.length) throw new Error(`检查失败:${failures.join(',')}`);
console.log(`catalog checks passed: ${targets.length} targets, ${packages.length} packages, ${menu.options.length} visible Kconfig options`);
