import {randomBytes} from "node:crypto";
import {existsSync,writeFileSync} from "node:fs";
import path from "node:path";
import {createInterface} from "node:readline/promises";
import {stdin as input,stdout as output} from "node:process";
import {Writable} from "node:stream";
import {loadConfig} from "../src/server/config.js";

const args=new Set(process.argv.slice(2));
const dryRun=args.has("--dry-run");
const targetArg=process.argv.find((value)=>value.startsWith("--output="));
const target=path.resolve(targetArg?.slice("--output=".length)||".env");
const interactive=Boolean(input.isTTY&&output.isTTY)&&!args.has("--defaults");
let suppressTerminalEcho=false;
const guardedOutput=new Writable({write(chunk,_encoding,done){if(!suppressTerminalEcho)output.write(chunk);done();}});
const rl=createInterface({input,output:guardedOutput,terminal:interactive});
const secret=()=>randomBytes(32).toString("base64url");
const ask=async(question:string,fallback="")=>interactive?(await rl.question(`${question}${fallback?` [${fallback}]`:""}: `)).trim()||fallback:fallback;
const askSecret=async(question:string)=>{
  if(!interactive)return "";
  output.write(`${question}: `);
  suppressTerminalEcho=true;
  try{return(await rl.question("")).trim();}
  finally{suppressTerminalEcho=false;output.write("\n");}
};
const confirm=async(question:string,defaultNo=true)=>{if(!interactive)return !defaultNo;const answer=(await rl.question(`${question} ${defaultNo?"[y/N]":"[Y/n]"} `)).trim().toLowerCase();return defaultNo?answer==="y"||answer==="yes":answer!=="n"&&answer!=="no";};

try{
  if(existsSync(target)&&!dryRun){if(!await confirm(`${target} already exists. Overwrite it?`))throw new Error("Setup stopped without changing the existing file.");}
  const publicBase=await ask("Public HTTPS base URL for provider callbacks","http://localhost:3000");
  const publicWss=await ask("Public secure WebSocket base URL",publicBase.replace(/^http/,"ws"));
  const ownerName=await ask("Owner display name","");
  const ownerPhone=await ask("Owner phone in E.164 format (blank for web-only)","");
  if(ownerPhone&&!/^\+[1-9]\d{7,14}$/.test(ownerPhone))throw new Error("Owner phone must use E.164 format, for example +13045550123.");
  const messaging=await ask("Messaging mode: web or twilio_sms","web");
  if(!["web","twilio_sms"].includes(messaging))throw new Error("Messaging mode must be web or twilio_sms.");
  const voice=await ask("Voice mode: simulator or twilio","simulator");
  if(!["simulator","twilio"].includes(voice))throw new Error("Voice mode must be simulator or twilio.");
  const llm=await ask("Model mode: mock or openai","mock");
  if(!["mock","openai"].includes(llm))throw new Error("Model mode must be mock or openai.");
  const accountSid=(messaging==="twilio_sms"||voice==="twilio")?await ask("Twilio Account SID",""):"";
  const authToken=(messaging==="twilio_sms"||voice==="twilio")?await askSecret("Twilio Auth Token (hidden)"):"";
  const messagingSid=messaging==="twilio_sms"?await ask("Twilio Messaging Service SID (blank to use an SMS number)",""):"";
  const smsFrom=messaging==="twilio_sms"&&!messagingSid?await ask("Twilio SMS sender in E.164 format",""):"";
  const voiceFrom=voice==="twilio"?await ask("Twilio voice sender in E.164 format",""):"";
  for(const[name,value]of [["SMS sender",smsFrom],["voice sender",voiceFrom]] as const)if(value&&!/^\+[1-9]\d{7,14}$/.test(value))throw new Error(`${name} must use E.164 format, for example +13045550123.`);
  const openaiKey=llm==="openai"?await askSecret("OpenAI API key (hidden)"):"";
  const accessKey=secret();
  const values=[
    "# Generated locally by Liaison. This data is never sent to the project maintainer.",
    "# Real messaging and calling stay off until you explicitly enable them.",
    "", "# Application",
    "APP_NAME=Liaison","NODE_ENV=development","PORT=3000",`PUBLIC_BASE_URL=${publicBase}`,`PUBLIC_WSS_URL=${publicWss}`,"DATABASE_PATH=./data/liaison.db",
    "", "# Single principal",
    "INSTANCE_MODE=personal",`OWNER_DISPLAY_NAME=${ownerName}`,`OWNER_PHONE_E164=${ownerPhone}`,
    "", "# Authentication - generated independently for this instance",
    `APP_ACCESS_KEY=${accessKey}`,`SESSION_SECRET=${secret()}`,`CALL_TOKEN_SECRET=${secret()}`,`ACTION_LINK_SECRET=${secret()}`,
    "", "# Model provider",
    `LLM_MODE=${llm}`,`OPENAI_API_KEY=${openaiKey}`,"OPENAI_BASE_URL=","PLANNER_MODEL=gpt-5.6-luna","CONTROLLER_MODEL=gpt-5.6-luna","OUTCOME_MODEL=gpt-5.6-luna","OPENAI_REASONING_EFFORT=low","OPENAI_TIMEOUT_MS=12000",
    "", "# Messaging",
    `MESSAGING_MODE=${messaging}`,"ALLOW_REAL_MESSAGING=false",`TWILIO_MESSAGING_SERVICE_SID=${messagingSid}`,`TWILIO_SMS_FROM_NUMBER=${smsFrom}`,"MESSAGING_REGISTRATION_CONFIRMED=false","SMS_UPDATE_DETAIL=STANDARD","SMS_DECISION_TIMEOUT_SECONDS=90","MAX_USER_WAIT_SECONDS=180","SMS_MAX_SEGMENTS_PER_MESSAGE=3","ESTIMATED_SMS_COST_PER_SEGMENT_USD=0","UNAUTHORIZED_SENDER_RESPONSE=false",
    "", "# Voice and shared Twilio credentials",
    `TELEPHONY_MODE=${voice}`,"ALLOW_REAL_CALLS=false",`TWILIO_ACCOUNT_SID=${accountSid}`,`TWILIO_AUTH_TOKEN=${authToken}`,`TWILIO_VOICE_FROM_NUMBER=${voiceFrom}`,"TWILIO_FROM_NUMBER=","MAX_CALL_DURATION_MINUTES=30","MAX_CALLS_PER_DAY=5","MAX_CONCURRENT_CALLS=1","ALLOWED_DESTINATION_PREFIXES=+1","ESTIMATED_TELEPHONY_COST_PER_MINUTE_USD=0.084",
    "", "# Security, retention, and logging",
    "SECURE_ACTION_LINK_TTL_MINUTES=10","DATA_RETENTION_DAYS=30","TRUST_PROXY=false","LOG_LEVEL=info","",
  ];
  const generated=Object.fromEntries(values.filter((line)=>line&&!line.startsWith("#")&&line.includes("=")).map((line)=>{const index=line.indexOf("=");return[line.slice(0,index),line.slice(index+1)];}));
  loadConfig({...process.env,...generated});
  if(!dryRun)writeFileSync(target,values.join("\n"),{encoding:"utf8",mode:0o600});
  output.write(`${dryRun?"Validated setup answers; no file written.":`Wrote ${target}.`}\n`);
  output.write(dryRun?"Access key: generated only when the configuration is written.\n":`Access key (store it now): ${accessKey}\n`);
  output.write("Next: npm run doctor\nThen: npm run dev\n");
  output.write(`Inbound SMS webhook: ${publicBase}/webhooks/twilio/messaging/inbound\n`);
  output.write(`SMS status callback: ${publicBase}/webhooks/twilio/messaging/status\n`);
  output.write("Real SMS and calls remain disabled until the operator explicitly enables them; provider use may incur charges.\n");
}finally{rl.close();}
