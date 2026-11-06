// Offline check of the OTP SMS (no network, no database): the message equals the DLT-approved template, the right
// sender / template / key are sent, USE_DEFAULT_OTP=true sends nothing, and a rejected SMS is an error.
//   node scripts/testSmsOtp.mjs
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

mongoose.set('bufferCommands', false); // the brand-name lookup fails at once instead of waiting for a database
Object.assign(process.env, {
  MONGODB_URI: 'mongodb://127.0.0.1:1', JWT_SECRET: 't', NODE_ENV: 'test', USE_DEFAULT_OTP: 'false',
  SMS_INDIA_HUB_API_KEY: 'key-123', SMS_INDIA_HUB_SENDER_ID: 'BGADEC', SMS_INDIA_HUB_DLT_TEMPLATE_ID: '1007282516644508833',
  DEMO_LOGIN_PHONES: '1111111111:1234,2222222222:1234',
});
delete process.env.SMS_INDIA_HUB_DLT_TEMPLATE_TEXT;

const sent = [];
let reply = '{"ErrorCode":"000","ErrorMessage":"Done","JobId":"77"}';
globalThis.fetch = async (url, options = {}) => {
  sent.push({ url: String(url), body: String(options.body || '') });
  return { ok: true, status: 200, statusText: 'OK', text: async () => reply };
};

const { sendOtpSms } = await import('../src/modules/taxi/services/smsService.js');
const { env } = await import('../src/config/env.js');
const { resolveDemoOtpForPhone } = await import('../src/modules/taxi/services/demoLoginService.js');

delete process.env.SMS_INDIA_HUB_DLT_TEMPLATE_TEXT; // the real .env may set it (and dotenv loads on import)
const result = await sendOtpSms({ phone: '9876543210', otp: '4821' });
assert.equal(result.mode, 'live');
const form = new URLSearchParams(sent[0].body);
assert.equal(form.get('msg'), 'Welcome to the App powered by Appzeto.Your OTP for registration is 4821.BGADEC', 'the approved wording, with the app name and the OTP');
assert.equal(form.get('sid'), 'BGADEC');
assert.equal(form.get('TemplateId'), '1007282516644508833');
assert.equal(form.get('msisdn'), '919876543210');
assert.equal(form.get('APIKey'), 'key-123');
assert.ok(sent[0].url.startsWith('http://cloud.smsindiahub.in/vendorsms/pushsms.aspx'));

process.env.SMS_INDIA_HUB_DLT_TEMPLATE_TEXT = 'Hello ##var## your code ##var##';
await sendOtpSms({ phone: '9876543210', otp: '1111' });
assert.equal(new URLSearchParams(sent.at(-1).body).get('msg'), 'Hello App your code 1111', 'the env text overrides the default');
delete process.env.SMS_INDIA_HUB_DLT_TEMPLATE_TEXT;

const before = sent.length;
env.sms.useDefaultOtp = 'true';
assert.equal((await sendOtpSms({ phone: '9876543210', otp: '1234' })).mode, 'debug', 'USE_DEFAULT_OTP=true sends no SMS');
assert.equal(sent.length, before);
env.sms.useDefaultOtp = 'false';

reply = '{"ErrorCode":"006","ErrorMessage":"Template does not match"}';
await assert.rejects(() => sendOtpSms({ phone: '9876543210', otp: '1' }), /rejected/);
await assert.rejects(() => sendOtpSms({ phone: '12345', otp: '1' }), /valid Indian mobile/);

assert.equal(resolveDemoOtpForPhone('1111111111'), '1234');
assert.equal(resolveDemoOtpForPhone('+91 22222 22222'), '1234');
assert.equal(resolveDemoOtpForPhone('9876543210'), null, 'every other number gets a real OTP');
console.log('sms otp: all checks passed');
process.exit(0);
