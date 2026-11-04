'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('admin inline scripts remain parseable, including embedded printing templates',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../public/admin.html'),'utf8');let count=0;
  for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)){
    if(/\bsrc\s*=/i.test(match[1]))continue;
    new vm.Script(match[2],{filename:'admin-inline-'+(++count)});
  }
  assert.ok(count>0,'at least one inline script must be checked');
});
