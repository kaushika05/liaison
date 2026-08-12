import { loadConfig } from "./config.js";
import { LiaisonDatabase } from "./database/db.js";

const config=loadConfig();
const database=new LiaisonDatabase(config.DATABASE_PATH);
try{
  const deleted=database.deleteExpired(config.DATA_RETENTION_DAYS);
  process.stdout.write(`${JSON.stringify({event:"retention_complete",retentionDays:config.DATA_RETENTION_DAYS,deletedCases:deleted})}\n`);
}finally{
  database.close();
}
