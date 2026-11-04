// Compatibility wrapper for synthetic portal browser fixtures only.
module.exports=function fixture(handler){
  const id='11111111-1111-4111-8111-111111111111';let revision=0,cart={},cycles=[];const receipts=new Map();
  const snapshot=()=>({cart_id:id,revision,cart,cycles});
  return async route=>{
    const request=route.request(),url=new URL(request.url()),body=()=>request.postDataJSON();
    const send=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
    if(url.pathname==='/api/portal/cart-state'){
      if(request.method()==='PUT'){
        cart=body().cart;revision++;
        cycles=[...new Set(Object.values(cart).map(l=>l.brand_id))].map((brand,i)=>({brand_id:brand,cycle_id:`22222222-2222-4222-8222-${String(i+1).padStart(12,'0')}`,revision:1,state:'open'}));
      }
      return send(snapshot());
    }
    if(url.pathname==='/api/portal/checkout-v2'){
      const payload=body();
      const proxy={request:()=>new Proxy(request,{get:(target,property)=>property==='url'?()=>request.url().replace('/checkout-v2','/checkout'):typeof target[property]==='function'?target[property].bind(target):target[property]}),
        fulfill:async options=>{
          const result=JSON.parse(options.body);if(result.orders){
            for(const order of result.orders.filter(o=>!o.error)){
              cart=Object.fromEntries(Object.entries(cart).filter(([,l])=>l.brand_id!==order.brand_id));
              const cycle=cycles.find(c=>c.brand_id===order.brand_id);if(cycle)cycle.state='converted';
            }
            revision++;Object.assign(result,{state:'complete',request_key:payload.request_key,pending_brands:[],cart:snapshot()});receipts.set(payload.request_key,result);
          }
          return route.fulfill({...options,body:JSON.stringify(result)});
        },abort:(...a)=>route.abort(...a),continue:(...a)=>route.continue(...a)};
      return handler(proxy);
    }
    if(url.pathname.startsWith('/api/portal/checkout-v2/'))return send(receipts.get(url.pathname.split('/').pop())||{state:'pending'});
    return handler(route);
  };
};
