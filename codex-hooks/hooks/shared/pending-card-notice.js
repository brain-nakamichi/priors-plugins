'use strict';
// Pure bounded projection: no input text, error text/token, persistence, or network.
const {parseSavedResponse,unwrapSaveResponse}=require('./save-response.js');
const ID=/^[A-Z][A-Z0-9]{1,7}-[0-9]+$/;
const validRef=r=>r&&ID.test(r.id)&&Number.isSafeInteger(r.version)&&r.version>0;
function pendingCardNotice(toolName,toolResponse){
 const name=typeof toolName==='string'&&toolName.startsWith('mcp__priors__')?toolName.slice(13):'';
 if(!['remember','amend','capture','maintain'].includes(name))return '';
 let parsed=parseSavedResponse(toolName,toolResponse);
 if(name==='maintain'){
  const r=unwrapSaveResponse(toolResponse);
  if(!r||!/^amend\.(revise|split|merge)$/.test(r.operation)||r.outcome_code!=='applied'||
   !Array.isArray(r.resource_ids)||!r.resource_ids.length||r.resource_ids.length>20)return '';
  const primary=r.resource_ids.filter(x=>x?.role==='primary');
  if(!primary.length||!primary.every(validRef))return '';
  parsed={response:r,ids:primary.map(x=>`${x.id}@${x.version}`)};
 }
 if(!parsed)return '';
 const r=parsed.response,allowed=new Set(parsed.ids),pending=new Set();
 const add=(ref,card)=>{if(validRef(ref)&&allowed.has(`${ref.id}@${ref.version}`)&&card?.state==='pending')pending.add(`${ref.id}@${ref.version}`);};
 if(name==='capture'){
  if(Array.isArray(r.items))for(const item of r.items.slice(0,20))if(item?.outcome_code==='recorded')add(item,item.search_card);
 }else{
  const primary=r.resource_ids.filter(x=>['primary','created','updated'].includes(x?.role));
  // Top-level card belongs to the one saved target; never guess with multiple targets.
  if(primary.length===1)add(primary[0],r.search_card);
  for(const ref of primary)add(ref,ref.search_card);
 }
 return pending.size?`検索カード未作成: ${[...pending].join('、')}。本文を書き直さず、search_card（本文の主張だけ）で各1回書く。`:'';
}
module.exports={pendingCardNotice};
