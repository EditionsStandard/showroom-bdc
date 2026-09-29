// Loaded only by the email integration test child, never by the application.
const fs = require('node:fs');
const originalFetch = global.fetch;
global.fetch = async (url, options) => {
  if (String(url).startsWith('https://api.resend.com/')) {
    const email = JSON.parse(options.body);
    if (email.to.some(value => value.startsWith('fail-mail-'))) return new Response(JSON.stringify({name:'validation_error',message:'Test transport failure'}),{status:422,headers:{'Content-Type':'application/json'}});
    fs.appendFileSync(process.env.TEST_MAIL_FILE,JSON.stringify(email)+'\n');
    return new Response(JSON.stringify({id:'test-message'}),{status:200,headers:{'Content-Type':'application/json'}});
  }
  return originalFetch(url, options);
};
