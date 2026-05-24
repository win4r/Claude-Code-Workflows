export const meta = {
  name: 'translate',
  description: 'Translate a word to a target language',
}

const { word, lang } = args

return await agent(`Translate "${word}" to ${lang}. Return ONLY the translation, no quotes, no explanation.`)
