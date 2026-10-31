/* Reviewed, additive schema upgrade for one pinned Preview branch/database only. */
const fs=require('node:fs');
const path=require('node:path');
const {approvedPreview}=require('./tally-sales-preview.cjs');
async function apply(db){
 const sql=fs.readFileSync(path.join(__dirname,'../prisma/migrations/20261102000000_tally_sales_sync/migration.sql'),'utf8');
 await db.$transaction(async tx=>{
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('tally-sales-schema-20261102'))`;
  const tables=await tx.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('TallySalesJob','TallySalesChunk','TallySalesSnapshot','TallySalesVoucher','TallySalesItem')`;
  const columns=await tx.$queryRaw`SELECT data_type,numeric_precision,numeric_scale FROM information_schema.columns WHERE table_schema='public' AND table_name='MonthlyEntry' AND column_name='saleQty'`;
  if(tables.length===5 && columns[0]?.data_type==='numeric' && columns[0]?.numeric_precision===18 && columns[0]?.numeric_scale===6)return;
  if(tables.length)throw Error('Partial sales schema requires review; no automatic repair attempted');
  if(columns[0]?.data_type!=='integer')throw Error('Unexpected original quantity type; schema upgrade stopped');
  for(const statement of sql.split(';').map(x=>x.trim()).filter(Boolean))await tx.$executeRawUnsafe(statement);
 },{timeout:55000,maxWait:10000});
}
async function main(){
 if(!approvedPreview()){
  if(process.env.VERCEL_ENV==='preview'&&process.env.VERCEL_GIT_COMMIT_REF===require('../config/tally-sales-preview.json').branch)
   throw Error('Sales Preview database identity guard did not match. No database change made.');
  console.log('Sales schema upgrade skipped outside the approved test Preview.');return;
 }
 const {PrismaClient}=require('@prisma/client');
 const db=new PrismaClient({datasources:{db:{url:process.env.DIRECT_URL}}});
 try{await apply(db);console.log('Sales schema ready on the approved test Preview database.');}
 finally{await db.$disconnect();}
}
if(require.main===module)main().catch(error=>{console.error('Test sales schema upgrade stopped: '+(error.code||error.errorCode||'SCHEMA_CHECK_FAILED'));process.exitCode=1;});
module.exports={apply};
