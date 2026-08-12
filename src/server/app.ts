import path from "node:path";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import staticFiles from "@fastify/static";
import middie from "@fastify/middie";
import twilio from "twilio";
import { z, ZodError } from "zod";
import type { RawData } from "ws";
import type { Config } from "./config.js";
import { loadConfig } from "./config.js";
import { safeKeyEqual, verifyToken } from "./core/policy.js";
import { LiaisonDatabase } from "./database/db.js";
import { DisclosureStore } from "./security/disclosures.js";
import { ModelService } from "./agent/model-service.js";
import { CallService } from "./services/call-service.js";

const idSchema=z.object({caseId:z.string().uuid()}); const callIdSchema=z.object({callId:z.string().uuid()});
const approvalParams=z.object({callId:z.string().uuid(),approvalId:z.string().uuid()});
const sessions=new Map<string,number>();

function sessionId(request:FastifyRequest):string|null{ const raw=request.cookies.liaison_session; if(!raw)return null; const unsigned=request.unsignCookie(raw); if(!unsigned.valid)return null; const expiry=sessions.get(unsigned.value); if(!expiry||expiry<Date.now()){sessions.delete(unsigned.value);return null;} return unsigned.value; }
function tokenSecret(config:Config){return config.CALL_TOKEN_SECRET||config.SESSION_SECRET||"liaison-development-call-token";}
function tokenCallId(token:string,config:Config):string|null{ const value=verifyToken<{callId:string}>(token,tokenSecret(config)); return value?.callId??null; }

export interface AppContext { app:FastifyInstance; service:CallService; database:LiaisonDatabase; disclosures:DisclosureStore }
export async function buildApp(overrides:Partial<Config>={},options:{serveClient?:boolean;databasePath?:string}={}):Promise<AppContext>{
  const config={...loadConfig(),...overrides,DATABASE_PATH:options.databasePath??overrides.DATABASE_PATH??loadConfig().DATABASE_PATH};
  const app=Fastify({logger:config.NODE_ENV==="test"?false:{level:config.LOG_LEVEL,redact:["req.headers.authorization","req.headers.cookie","res.headers.set-cookie"]},bodyLimit:256*1024,trustProxy:config.TRUST_PROXY,requestIdHeader:"x-request-id",genReqId:()=>randomUUID()});
  const database=new LiaisonDatabase(config.DATABASE_PATH); const disclosures=new DisclosureStore(); const service=new CallService(config,database,disclosures,new ModelService(config,(item)=>app.log.info({event:"model_response",...item},"OpenAI response completed")));await service.recoverInterruptedCall();
  await app.register(cookie,{secret:config.SESSION_SECRET||"liaison-development-session-secret-change-me"});
  await app.register(formbody); await app.register(helmet,{contentSecurityPolicy:config.NODE_ENV==="production"?{directives:{defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'"],imgSrc:["'self'","data:"],connectSrc:["'self'"]}}:false});
  await app.register(rateLimit,{global:true,max:180,timeWindow:"1 minute"}); await app.register(websocket);

  app.addHook("onRequest",async(request,reply)=>{
    const mutation=["POST","PATCH","PUT","DELETE"].includes(request.method); if(!mutation||request.url.startsWith("/webhooks/twilio/"))return;
    const origin=request.headers.origin; if(origin){ const allowed=new URL(config.PUBLIC_BASE_URL).origin; const local=config.NODE_ENV!=="production"&&/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin); if(origin!==allowed&&!local){reply.code(403).send({error:{code:"ORIGIN_REJECTED",message:"Request origin was not accepted."}});return reply;} }
  });
  app.addHook("preHandler",async(request,reply)=>{
    if(!request.url.startsWith("/api/")||request.url==="/api/auth/login"||request.url==="/api/session")return;
    if(!sessionId(request)){reply.code(401).send({error:{code:"AUTH_REQUIRED",message:"Enter the deployment access key to continue."}});return reply;}
  });

  app.get("/health",async()=>({status:"ok"}));
  app.get("/ready",async(_request,reply)=>database.ready()?{status:"ready"}:reply.code(503).send({status:"not_ready"}));
  app.get("/api/session",async(request)=>({authenticated:Boolean(sessionId(request)),config:service.configStatus()}));
  app.post("/api/auth/login",{config:{rateLimit:{max:8,timeWindow:"15 minutes"}}},async(request,reply)=>{
    const body=z.object({accessKey:z.string().max(500).default("")}).parse(request.body??{}); const bypass=config.NODE_ENV!=="production"&&!config.APP_ACCESS_KEY;
    if(!bypass&&!safeKeyEqual(body.accessKey,config.APP_ACCESS_KEY)){await new Promise((resolve)=>setTimeout(resolve,180));return reply.code(401).send({error:{code:"INVALID_ACCESS_KEY",message:"The access key was not accepted."}});}
    const id=randomUUID();sessions.set(id,Date.now()+12*60*60_000);reply.setCookie("liaison_session",id,{httpOnly:true,secure:config.NODE_ENV==="production",sameSite:"strict",signed:true,path:"/",maxAge:12*60*60});return {authenticated:true,config:service.configStatus()};
  });
  app.post("/api/auth/logout",async(request,reply)=>{const id=sessionId(request);if(id)sessions.delete(id);reply.clearCookie("liaison_session",{path:"/"});return {authenticated:false};});

  app.get("/api/cases",async()=>({cases:service.listCases(),activeCall:database.getActiveCall()?.id??null}));
  app.post("/api/cases",async(request,reply)=>reply.code(201).send(await service.createCase(request.body)));
  app.get("/api/cases/:caseId",async(request)=>service.getCase(idSchema.parse(request.params).caseId)??(()=>{throw new Error("CASE_NOT_FOUND")})());
  app.delete("/api/cases/:caseId",async(request,reply)=>{service.deleteCase(idSchema.parse(request.params).caseId);return reply.code(204).send();});
  app.post("/api/cases/:caseId/plan",async(request)=>service.generatePlan(idSchema.parse(request.params).caseId));
  app.patch("/api/cases/:caseId/plan",async(request)=>service.savePlan(idSchema.parse(request.params).caseId,request.body));
  app.post("/api/cases/:caseId/plan/approve",async(request)=>service.approvePlan(idSchema.parse(request.params).caseId));
  app.get("/api/simulator/scenarios",async()=>({scenarios:service.listScenarios()}));
  app.post("/api/cases/:caseId/simulate",async(request)=>{const body=z.object({scenarioId:z.string(),accelerated:z.boolean().default(true)}).parse(request.body);return service.startSimulation(idSchema.parse(request.params).caseId,body.scenarioId,body.accelerated);});
  app.post("/api/cases/:caseId/calls",async(request)=>{z.object({confirmed:z.literal(true),privacyConfirmed:z.literal(true)}).parse(request.body);return service.startLive(idSchema.parse(request.params).caseId);});

  app.get("/api/calls/:callId",async(request)=>service.snapshot(callIdSchema.parse(request.params).callId));
  app.get("/api/calls/:callId/events",async(request,reply)=>{
    const callId=callIdSchema.parse(request.params).callId; service.snapshot(callId); const last=Number(request.headers["last-event-id"]??0)||0;
    reply.hijack(); reply.raw.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-cache, no-transform","Connection":"keep-alive","X-Accel-Buffering":"no"});
    const write=(event:{id:number;type:string;data:unknown})=>reply.raw.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
    write({id:last,type:"snapshot",data:service.snapshot(callId)}); for(const event of service.storedEvents(callId,last))write({id:event.sequence,type:"audit.event",data:event});
    const unsubscribe=service.onCallEvent(callId,write); const heartbeat=setInterval(()=>reply.raw.write(`: heartbeat ${Date.now()}\n\n`),15_000); const cleanup=()=>{clearInterval(heartbeat);unsubscribe();}; request.raw.once("close",cleanup); reply.raw.once("close",cleanup);
  });
  app.post("/api/calls/:callId/pause",async(request)=>service.pause(callIdSchema.parse(request.params).callId));
  app.post("/api/calls/:callId/resume",async(request)=>service.resume(callIdSchema.parse(request.params).callId));
  app.post("/api/calls/:callId/hangup",async(request)=>service.hangup(callIdSchema.parse(request.params).callId));
  app.post("/api/calls/:callId/private-instruction",async(request)=>service.privateInstruction(callIdSchema.parse(request.params).callId,z.object({text:z.string().min(1).max(1000)}).parse(request.body).text));
  app.post("/api/calls/:callId/exact-text",async(request)=>service.exactText(callIdSchema.parse(request.params).callId,z.object({text:z.string().min(1).max(400)}).parse(request.body).text));
  app.post("/api/calls/:callId/approvals/:approvalId/approve",async(request)=>service.approve(approvalParams.parse(request.params).callId,approvalParams.parse(request.params).approvalId));
  app.post("/api/calls/:callId/approvals/:approvalId/reject",async(request)=>{const p=approvalParams.parse(request.params);const b=z.object({instruction:z.string().max(500).optional()}).parse(request.body??{});return service.reject(p.callId,p.approvalId,b.instruction);});
  app.post("/api/calls/:callId/approvals/:approvalId/replace",async(request)=>{const p=approvalParams.parse(request.params);return service.approve(p.callId,p.approvalId,z.object({text:z.string().min(1).max(400)}).parse(request.body).text);});
  app.get("/api/calls/:callId/outcome",async(request)=>service.exportJson(callIdSchema.parse(request.params).callId));
  app.get("/api/calls/:callId/export.json",async(request,reply)=>{const id=callIdSchema.parse(request.params).callId;reply.header("Content-Disposition",`attachment; filename=liaison-${id}.json`).type("application/json");return service.exportJson(id);});
  app.get("/api/calls/:callId/export.txt",async(request,reply)=>{const id=callIdSchema.parse(request.params).callId;reply.header("Content-Disposition",`attachment; filename=liaison-${id}.txt`).type("text/plain; charset=utf-8");return service.exportText(id);});

  const validateTwilio=(request:FastifyRequest,url:string)=>{const signature=String(request.headers["x-twilio-signature"]??"");const body=request.body&&typeof request.body==="object"?request.body as Record<string,string>:{};return twilio.validateRequest(config.TWILIO_AUTH_TOKEN,signature,url,body);};
  app.post("/webhooks/twilio/voice/:signedToken",async(request,reply)=>{
    const token=z.object({signedToken:z.string()}).parse(request.params).signedToken; const callId=tokenCallId(token,config); if(!callId)return reply.code(403).send("Invalid call token"); const url=`${config.PUBLIC_BASE_URL}${request.url}`; if(!validateTwilio(request,url))return reply.code(403).send("Invalid Twilio signature");
    const voice=new twilio.twiml.VoiceResponse(); const connect=voice.connect({action:`${config.PUBLIC_BASE_URL}/webhooks/twilio/conversation-action/${encodeURIComponent(token)}`,method:"POST"}); const relay=connect.conversationRelay({url:`${config.PUBLIC_WSS_URL}/webhooks/twilio/conversation-relay/${encodeURIComponent(token)}`,dtmfDetection:true,language:"en-US",partialPrompts:false,interruptible:"speech",interruptSensitivity:"medium",ignorebackchannel:"true",welcomeGreetingInterruptible:"none"}); relay.parameter({name:"callReference",value:callId}); reply.type("text/xml");return voice.toString();
  });
  app.post("/webhooks/twilio/status/:signedToken",async(request,reply)=>{const token=z.object({signedToken:z.string()}).parse(request.params).signedToken;const callId=tokenCallId(token,config);if(!callId)return reply.code(403).send();if(!validateTwilio(request,`${config.PUBLIC_BASE_URL}${request.url}`))return reply.code(403).send();const status=String((request.body as Record<string,unknown>)?.CallStatus??"");await service.twilioStatus(callId,status);return reply.code(204).send();});
  app.post("/webhooks/twilio/conversation-action/:signedToken",async(request,reply)=>{const token=z.object({signedToken:z.string()}).parse(request.params).signedToken;const callId=tokenCallId(token,config);if(!callId)return reply.code(403).send();if(!validateTwilio(request,`${config.PUBLIC_BASE_URL}${request.url}`))return reply.code(403).send();const status=String((request.body as Record<string,unknown>)?.SessionStatus??"ended");await service.conversationEnded(callId,status);reply.type("text/xml");return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response/>";});
  app.get("/webhooks/twilio/conversation-relay/:signedToken",{websocket:true},(socket,request)=>{
    const token=z.object({signedToken:z.string()}).parse(request.params).signedToken;const callId=tokenCallId(token,config);const signature=String(request.headers["x-twilio-signature"]??"");const url=`${config.PUBLIC_WSS_URL}${request.url}`;
    if(!callId||!twilio.validateRequest(config.TWILIO_AUTH_TOKEN,signature,url,{})){socket.close(1008,"Signature validation failed");return;} service.attachRelaySocket(callId,socket);
    socket.on("message",(data:RawData)=>{try{const message=JSON.parse(data.toString()) as unknown;void service.relayMessage(callId,message).catch(()=>socket.close(1011,"Relay processing failed"));}catch{socket.close(1007,"Malformed JSON");}}); socket.once("close",()=>void service.relayClosed(callId));
  });

  app.setErrorHandler((error,_request,reply)=>{const known=error instanceof ZodError;const message=error instanceof Error?error.message:"INTERNAL_ERROR";const code=known?"VALIDATION_ERROR":message.split(":")[0]||"INTERNAL_ERROR";const status=known?400:code.endsWith("NOT_FOUND")?404:["ANOTHER_CALL_IS_ACTIVE","STALE_APPROVAL","CALL_ALREADY_ENDED"].includes(code)?409:code==="AUTH_REQUIRED"?401:code==="INTERNAL_ERROR"?500:400;reply.code(status).send({error:{code,message:status===500?"An internal error occurred.":message}});});

  if(options.serveClient!==false){
    if(config.NODE_ENV==="production"){await app.register(staticFiles,{root:path.resolve("dist")});app.setNotFoundHandler((request,reply)=>request.method==="GET"?reply.sendFile("index.html"):reply.code(404).send({error:{code:"NOT_FOUND",message:"Not found"}}));}
    else {await app.register(middie);const {createServer}=await import("vite");const vite=await createServer({server:{middlewareMode:true},appType:"spa"});app.use((request,response,next)=>{const url=request.url??"";if(url.startsWith("/api/")||url==="/health"||url==="/ready"||url.startsWith("/webhooks/"))return next();return vite.middlewares(request,response,next)});app.addHook("onClose",async()=>vite.close());}
  }
  const cleanup=setInterval(()=>{const now=Date.now();for(const[id,expiry]of sessions)if(expiry<now)sessions.delete(id);},60_000);cleanup.unref();
  app.addHook("onClose",async()=>{clearInterval(cleanup);disclosures.clearAll();database.close();});
  return {app,service,database,disclosures};
}
