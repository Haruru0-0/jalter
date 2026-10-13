import { test } from 'node:test';
import assert from 'node:assert/strict';
import { builderModal, templateNameModal, fieldModal } from '../../src/features/embeds/index.js';
import { LANGS } from '../../src/i18n/index.js';

// toJSON runs discord.js validation (labels <= 45 chars, title <= 45, value <= max length).
test('the builder and template modals are valid in every language', () => {
  for (const lang of LANGS) {
    const json = builderModal(lang, '123').toJSON();
    assert.equal(json.custom_id, 'embeds:modal:123');
    assert.equal(json.components.length, 5);
    assert.equal(templateNameModal(lang).toJSON().custom_id, 'embeds:tplmodal');
  }
});

test('the builder modal is prefilled from a draft', () => {
  const spec = { title: 'T', description: 'D', color: '#000000', footer: 'F', image: { type: 'stored', name: 'logo' } };
  const values = builderModal('en', '1', spec).toJSON().components.map((row) => row.components[0].value);
  assert.deepEqual(values, ['T', 'D', '#000000', 'F', 'logo']);
  const url = builderModal('en', '1', { title: 'x', image: { type: 'url', url: 'https://x.test/a.png' } }).toJSON();
  assert.equal(url.components[4].components[0].value, 'https://x.test/a.png');
});

test('the add-field modal is valid in every language', () => {
  for (const lang of LANGS) {
    const json = fieldModal(lang, '123').toJSON();
    assert.equal(json.custom_id, 'embeds:fieldmodal:123');
    assert.deepEqual(json.components.map((row) => row.components[0].custom_id), ['name', 'value', 'inline']);
  }
});
