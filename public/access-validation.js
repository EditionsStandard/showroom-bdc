// Shared validation: browser and server use the same rules.
(function(root) {
  const businessTypes = ['Retailer', 'Department Store', 'E-commerce', 'Press', 'Stylist', 'Agent', 'Other'];
  function validate(input) {
    input = input && typeof input === 'object' ? input : {};
    const data = {}, errors = {};
    const limits = {name:200, company:200, job_title:160, country:100, city:160, email:254, business_type:40, phone:80, website:2048, instagram:200, message:4000};
    for (const [key, max] of Object.entries(limits)) {
      data[key] = typeof input[key] === 'string' ? input[key].trim() : '';
      if (input[key] != null && typeof input[key] !== 'string') errors[key] = 'invalid';
      if (data[key].length > max) errors[key] = 'too_long';
    }
    for (const key of ['name','company','job_title','country','city','email','business_type']) {
      if (!data[key]) errors[key] = 'required';
    }
    if (['other','autre'].includes(data.country.toLowerCase())) errors.country = 'country';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(data.email)) errors.email = 'email';
    data.email = data.email.toLowerCase();
    if (!businessTypes.includes(data.business_type)) errors.business_type = 'required';
    if (!data.website && !data.instagram) errors.website = 'presence';
    if (data.website) {
      try {
        const url = new URL(data.website);
        if (!['https:','http:'].includes(url.protocol) || !url.hostname.includes('.') || url.username || url.password) throw Error();
        data.website = url.href;
      } catch (_) { errors.website = 'website'; }
    }
    if (data.instagram) {
      let handle = data.instagram.replace(/^@/, '');
      if (/^https?:\/\//i.test(handle)) {
        try {
          const url = new URL(handle);
          if (!['instagram.com','www.instagram.com'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw Error();
          handle = url.pathname.replace(/^\/|\/$/g, '');
        } catch (_) { errors.instagram = 'instagram'; }
      }
      if (!/^[a-zA-Z0-9_](?:[a-zA-Z0-9_.]{0,28}[a-zA-Z0-9_])?$/.test(handle) || handle.includes('..') || ['p','reel','reels','stories','explore','accounts','direct'].includes(handle.toLowerCase())) errors.instagram = 'instagram';
      data.instagram = handle;
    }
    if (input.privacy_accepted !== true) errors.privacy_accepted = 'privacy';
    data.privacy_accepted = input.privacy_accepted === true;
    data.marketing_consent = input.marketing_consent === true;
    return {data, errors, valid: Object.keys(errors).length === 0};
  }
  const api = {validate, businessTypes};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AccessValidation = api;
})(typeof window !== 'undefined' ? window : globalThis);
