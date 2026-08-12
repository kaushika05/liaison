import { afterEach,describe,expect,it } from "vitest";
import { buildApp, type AppContext } from "../../src/server/app.js";

let context:AppContext|undefined;
afterEach(async()=>{await context?.app.close();context=undefined});

describe("access-key authentication",()=>{
  it("rejects unauthenticated API access and accepts a signed session cookie",async()=>{
    context=await buildApp({NODE_ENV:"test",LLM_MODE:"mock",TELEPHONY_MODE:"simulator",DATABASE_PATH:":memory:",APP_ACCESS_KEY:"correct-key",SESSION_SECRET:"test-session",CALL_TOKEN_SECRET:"test-call",PUBLIC_BASE_URL:"http://localhost:3000"},{serveClient:false,databasePath:":memory:"});
    await context.app.ready();
    expect((await context.app.inject({method:"GET",url:"/api/cases"})).statusCode).toBe(401);
    const denied=await context.app.inject({method:"POST",url:"/api/auth/login",payload:{accessKey:"wrong-key"}});
    expect(denied.statusCode).toBe(401);expect(denied.body).not.toContain("correct-key");
    const login=await context.app.inject({method:"POST",url:"/api/auth/login",payload:{accessKey:"correct-key"}});
    expect(login.statusCode).toBe(200);const cookie=login.headers["set-cookie"]?.toString().split(";")[0];expect(cookie).toContain("liaison_session=");
    expect((await context.app.inject({method:"GET",url:"/api/cases",headers:{cookie:cookie!}})).statusCode).toBe(200);
  });

  it("rejects a cross-origin mutation",async()=>{
    context=await buildApp({NODE_ENV:"test",LLM_MODE:"mock",TELEPHONY_MODE:"simulator",DATABASE_PATH:":memory:",APP_ACCESS_KEY:"correct-key",SESSION_SECRET:"test-session",CALL_TOKEN_SECRET:"test-call",PUBLIC_BASE_URL:"http://localhost:3000"},{serveClient:false,databasePath:":memory:"});
    await context.app.ready();const response=await context.app.inject({method:"POST",url:"/api/auth/login",headers:{origin:"https://attacker.example"},payload:{accessKey:"correct-key"}});expect(response.statusCode).toBe(403);
  });
});
