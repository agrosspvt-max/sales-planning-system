const {createHash}=require('node:crypto');
const approved=require('../config/tally-sales-preview.json');
const norm=host=>host.replace('-pooler.','.').toLowerCase();
function approvedPreview(env=process.env){
 if(env.VERCEL_ENV!=='preview'||env.VERCEL_GIT_COMMIT_REF!==approved.branch||env.TALLY_SYNC_ENABLED!=='true')return false;
 try{
  const hosts=[env.DATABASE_URL,env.DIRECT_URL].map(value=>norm(new URL(value).hostname));
  return hosts.every(host=>host===norm(env.TALLY_EXPECTED_DB_HOST||'')&&createHash('sha256').update(host).digest('hex')===approved.databaseHostSha256);
 }catch{return false;}
}
module.exports={approvedPreview};
