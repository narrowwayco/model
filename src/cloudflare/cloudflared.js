const path = require('path');
const { spawn, execSync, spawnSync  } = require('child_process');
const { app } = require('electron');
const fs = require('fs');
const log = require('../logger');
const cloudflareApi = require('./api/cloudflareApi.js');
const {homedir} = require("node:os");

// ✅ Electron이 실행된 디렉토리를 가져옴 (설치된 실제 경로)
const basePath = path.dirname(app.getPath('exe')); // model.exe의 디렉토리 찾기
const cloudflaredDir = path.join(basePath, 'cloudflared'); // Cloudflare 실행 폴더
const configFile = path.join(cloudflaredDir, 'config.yml');
const bundledCloudflaredBin = path.join(cloudflaredDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
const systemCloudflaredBin = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
const cloudflaredBin = fs.existsSync(bundledCloudflaredBin) ? bundledCloudflaredBin : systemCloudflaredBin;
const oldCertFile = path.join(cloudflaredDir, 'cert.pem');
let certFile;
let credentialsFile;
let cloudflareProcess = null; // ✅ Cloudflare 프로세스 핸들러

// ✅ 기존 터널 목록 확인 및 UUID 가져오기1
async function getOrCreateTunnel(tunnelName = "model-app") {
    try {
        tunnelName = tunnelName + "-model-app";

        const certFileDir = path.join(homedir(), ".cloudflared");

        if (!fs.existsSync(certFileDir)) {
            fs.mkdirSync(certFileDir, { recursive: true });
            console.log(`디렉토리가 생성되었습니다: ${certFileDir}`);
        } else {
            console.log(`디렉토리가 이미 존재합니다: ${certFileDir}`);
        }

        certFile = path.join(homedir(), ".cloudflared", "cert.pem");

        log.info("🔍 Cloudflare cert 인증서 확인 중... ");
        if (fs.existsSync(oldCertFile)) {
            try {
               fs.copyFileSync(oldCertFile, certFile);
               log.info(`✅ cert 파일 복사 완료: ${certFile}`);
            } catch (err) {
               throw new Error(`❌ cert 인증서 복사 실패: ${err.message}`);
            }
        } else if (fs.existsSync(certFile)) {
            log.info(`✅ 기존 cert 파일 사용: ${certFile}`);
        } else {
            throw new Error(`❌ Cloudflare cert.pem 없음. 먼저 'cloudflared tunnel login'으로 인증이 필요합니다: ${certFile}`);
        }

        log.info("🔍 기존 Cloudflare 터널 UUID 확인 중... tunnelName: ", tunnelName);

        // ✅ 기존 터널 목록 조회
        const listOutput = spawnSync(cloudflaredBin, ["tunnel", "list"], { encoding: "utf8" });
        if (listOutput.error) throw listOutput.error;

        const stderr = listOutput.stderr.toString().trim();

        // 단순 경고는 무시
        if (stderr && !stderr.includes("outdated")) {
            throw new Error(stderr);
        }
        const listData = listOutput.stdout.toString();

        // ✅ 터널 목록에서 `model-app`의 UUID 추출
        const match = listData.match(new RegExp(`([a-f0-9-]+)\\s+${tunnelName}`));
        let tunnelUUID = match ? match[1] : null;

        if (tunnelUUID) {
            log.info(`✅ 기존 터널 UUID 사용: ${tunnelUUID}`);

            // ✅ 기본 경로에 저장된 인증서 파일을 경로 저장
            credentialsFile = path.join(homedir(), ".cloudflared", `${tunnelUUID}.json`);

            /*const oldCredentialsFile = path.join(homedir(), ".cloudflared", `${tunnelUUID}.json`);
            credentialsFile = path.join(cloudflaredDir, `${tunnelUUID}.json`);
            
            try {
                fs.copyFileSync(oldCredentialsFile, credentialsFile);
                log.info(`✅ 터널 JSON 파일 복사 완료: ${credentialsFile}`);
            } catch (err) {
                throw new Error(`❌ 터널 인증서 복사 실패: ${err.message}`);
            }*/
            log.info(`✅ 기존 터널 JSON 파일 위치: ${credentialsFile}`);

            return tunnelUUID;
        }

        log.info("🆕 기존 터널이 없음. 새 터널 생성 중...");

        // ✅ 새로운 터널 생성 (spawnSync 사용)
        const createProcess = spawnSync(cloudflaredBin, [
            "tunnel", "create", tunnelName], { encoding: "utf8" });

        // ✅ 생성된 터널의 출력 확인
        if (createProcess.error) throw createProcess.error;

        const stderrProcess = createProcess.stderr.toString().trim();

        // 단순 경고는 무시
        if (stderrProcess && !stderrProcess.includes("outdated")) {
            throw new Error(stderrProcess);
        }

        const createOutput = createProcess.stdout.toString();

        // ✅ 터널 UUID 추출
        const newMatch = createOutput.match(/Created tunnel .* with id ([a-f0-9-]+)/);
        if (!newMatch) {
            throw new Error("❌ 터널 UUID 생성 실패");
        }

        tunnelUUID = newMatch[1].trim();
        log.info(`✅ 새 터널 UUID: ${tunnelUUID}`);

        // ✅ 기본 경로에 저장된 인증서 파일을 경로 저장
        credentialsFile = path.join(homedir(), ".cloudflared", `${tunnelUUID}.json`);

       /* const oldCredentialsFile = path.join(homedir(), ".cloudflared", `${tunnelUUID}.json`);
        credentialsFile = path.join(cloudflaredDir, `${tunnelUUID}.json`);

        try {
            fs.copyFileSync(oldCredentialsFile, credentialsFile);
            log.info(`✅ 터널 JSON 파일 복사 완료: ${credentialsFile}`);
        } catch (err) {
            throw new Error(`❌ 터널 인증서 복사 실패: ${err.message}`);
        }
        */
        log.info(`✅ 터널 JSON 파일 저장 위치: ${credentialsFile}`);

        return tunnelUUID;
    } catch (error) {
        log.error(`❌ 터널 처리 실패: ${error.message}`);
        return null;
    }
}


// ✅ Cloudflare 실행 여부 체크 함수
function isCloudflareRunning() {
    try {
        const output = execSync('tasklist', { encoding: 'utf-8' });
        return output.includes('cloudflared.exe');
    } catch (error) {
        return false;
    }
}

// ✅ Cloudflare 종료 함수
function stopCloudflareTunnel() {
    if (cloudflareProcess) {
        log.info("⚠️ Cloudflare Tunnel 종료 중...");
        cloudflareProcess.kill('SIGTERM');
        cloudflareProcess = null;
        if (process.platform === 'win32') {
            try {
                execSync('taskkill /F /IM cloudflared.exe'); // 강제 종료
                log.info("✅ Cloudflare Tunnel 강제 종료 완료 (Windows)");
            } catch (error) {
                log.error("❌ Cloudflare 종료 실패 (Windows):", error.message);
            }
        }
    }
}

// ✅ Cloudflare Tunnel을 종료하고 다시 실행하는 함수
async function restartCloudflareTunnel() {
    log.info("🔄 Cloudflare Tunnel 재시작 중...");

    // ✅ 기존 프로세스 종료
    stopCloudflareTunnel();

    // ✅ 종료 대기 (완전한 종료를 위해 약간의 대기 시간 추가)
    await new Promise(resolve => setTimeout(resolve, 2000));
}

//터널 api 검사해서 죽었을경우 터널 재실행
async function checkTunnelHealth(userId) {
    try {
        // 내부 API 체크
        const localRes = await fetch('http://localhost:3142/health', { timeout: 3000 });
        if (!localRes.ok) throw new Error("Local API unhealthy");

        // 외부 API 체크
        const externalRes = await fetch(`https://${userId}.nw-api.org/health`, { timeout: 5000 });
        if (!externalRes.ok) throw new Error("External API unhealthy");

    } catch (e) {
        log.warn(`⚠️ Healthcheck 실패 (${e.message}) → 터널 재시작`);
        await restartCloudflareTunnel();
        await startCloudflareTunnel();
    }
}

// ✅ Cloudflare Tunnel 실행 함수
function startCloudflareTunnel() {

    if (!fs.existsSync(configFile)) {
        log.error("❌ config.yml 없음! 먼저 `setupCloudflare()`를 실행하세요.");
        return;
    }

    // ✅ Cloudflare Tunnel 실행
    log.info("🚀 Cloudflare Tunnel 실행 중...");
    cloudflareProcess = spawn(cloudflaredBin, ['tunnel', '--config', configFile, 'run'], { shell: true });

    cloudflareProcess.stdout.on('data', (data) => log.info(`Cloudflared: ${data}`));
    cloudflareProcess.stderr.on('data', (data) => log.info(`Cloudflared log: ${data}`));

    cloudflareProcess.on('close', (code) => log.info(`Cloudflared 종료 (코드: ${code})`));
}

// ✅ 전체 실행
async function setupCloudflare(userId) {
    log.info("🚀 Cloudflare 설정 시작...");

    // ✅ 기존 Cloudflare Tunnel 종료 후 재시작
    await restartCloudflareTunnel();

    log.warn("✅️ 터널 생성 시작 ");

    // ✅ 터널 신규 생성 또는 기존 터널 조회
    const tunnelUUID = await getOrCreateTunnel(userId);

    // ✅ config.yml을 먼저 생성해야 터널 실행 가능!
    await generateConfigYml(tunnelUUID,`${userId}.nw-api.org`);

    // ✅ config.yml이 준비된 후 터널 실행
    log.info("🚀 Cloudflare 터널 실행...");
    await startCloudflareTunnel();

    // ✅ 터널 실행 후 서브도메인 생성
    log.info("🔗 서브도메인 생성 중...");
    const url = await cloudflareApi.updateOrCreateCloudflareSubdomain(`${userId}`, tunnelUUID);

    if (!url) {
        log.error("❌ 서브 도메인 생성 실패.");
        return;
    }

    log.info(`✅ 설정 완료: ${url} 에서 접속 가능`);
}

// ✅ `config.yml` 생성 함수
async function generateConfigYml(tunnelUUID, url) {
    try {
        log.info("🚀 config.yml 생성 중...");
        fs.mkdirSync(cloudflaredDir, { recursive: true });
        log.info("🚀 tunnelUUID 생성 중...", tunnelUUID);
        if (!url) {
            log.error("❌ 사용자 URL 정보 없음!");
            return;
        }

        const configContent = `tunnel: ${tunnelUUID}
credentials-file: ${credentialsFile}
origincert: ${certFile}

originRequest:
  connectTimeout: 600s         # 연결 대기 최대 10분
  tcpKeepAlive: 600s           # TCP keepalive도 10분
  noHappyEyeballs: true        # IPv4/IPv6 fallback 비활성화
  disableChunkedEncoding: true # Content-Length로 긴 응답 지원

ingress:
  - hostname: ${url}
    service: http://localhost:3142
  - service: http_status:404

warp-routing:
  enabled: true
`;

        fs.writeFileSync(configFile, configContent);
        log.info(`✅ config.yml 생성 완료: ${url} 에서 접속 가능`);
    } catch (error) {
        log.error(`❌ config.yml 생성 실패: ${error.message}`);
    }
}

module.exports = { setupCloudflare, isCloudflareRunning, stopCloudflareTunnel, checkTunnelHealth };
