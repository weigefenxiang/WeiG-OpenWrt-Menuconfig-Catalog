from pathlib import Path

path = Path('.github/workflows/catalog.yml')
text = path.read_text(encoding='utf-8')
old_if = "        if: steps.kconfig_contract.outcome == 'success' && github.ref_name == 'fix-E'"
new_if = "        if: steps.kconfig_contract.outcome == 'success' && (github.ref_name == 'fix-E' || github.ref_name == 'dev')"
old_stage = "          EXPERIMENT_STAGE: ${{ github.ref_name == 'fix-E' && 'profile-config-groups' || '' }}"
new_stage = "          EXPERIMENT_STAGE: ${{ (github.ref_name == 'fix-E' || github.ref_name == 'dev') && 'profile-config-groups' || '' }}"
if text.count(old_if) != 1:
    raise SystemExit(f'profile step condition count={text.count(old_if)}')
if text.count(old_stage) != 1:
    raise SystemExit(f'profile attempt condition count={text.count(old_stage)}')
text = text.replace(old_if, new_if, 1).replace(old_stage, new_stage, 1)
path.write_text(text, encoding='utf-8')
print('Enabled Native Profile Config Groups on fix-E and dev')
