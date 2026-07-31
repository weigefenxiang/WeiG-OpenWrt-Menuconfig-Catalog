#!/usr/bin/env node

const requested = String(process.env.TRANSLATION_PROVIDER_REQUEST || 'default').trim().toLowerCase();
const fallback = String(process.env.TRANSLATION_PROVIDER_DEFAULT || 'argos').trim().toLowerCase();
const provider = requested === 'default' ? fallback : requested;
if (!['argos', 'azure', 'off'].includes(provider)) {
  throw new Error(`Unsupported translation provider: ${provider}`);
}
console.log(`provider=${provider}`);
console.log(`enabled=${provider !== 'off'}`);
