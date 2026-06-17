const puppeteer = require('puppeteer');

async function rodarMinerador() {
    console.log('[Scout] Iniciando Robô Sentinela...');
    const browser = await puppeteer.launch({ headless: false, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const processados = new Set();

    // 1. CARREGA UMA ÚNICA VEZ
    await page.goto('https://www.radarfutebol.com/', { waitUntil: 'networkidle2' });

    // Configurações iniciais (Cookies e Ao Vivo)
    await page.evaluate(() => {
        const btn = document.querySelector('button[data-role="all"]');
        if (btn) btn.click();
        const liveBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText?.toUpperCase().includes('AO VIVO'));
        if (liveBtn) liveBtn.click();
    });

    // 2. LOOP DE MONITORAMENTO (Sem recarregar)
    while (true) {
        try {
            console.log(`[${new Date().toLocaleTimeString()}] Monitorando grade existente...`);

            // Re-mapeia a grade atual (após as remoções feitas anteriormente)
            const radarElements = await page.$$('tbody tr .radar');
            const totalRadares = radarElements.length;

            console.log(`[Scout] Radares ativos na grade: ${totalRadares}`);

            for (let i = 0; i < totalRadares; i++) {
                try {
                    // Referência direta para clicar e remover
                    const elementoRadar = await page.$$('tbody tr .radar').then(els => els[i]);
                    if (!elementoRadar) continue;

                    const newPagePromise = new Promise(resolve => browser.once('targetcreated', target => resolve(target.page())));

                    await elementoRadar.evaluate(el => el.click());

                    const novaAba = await Promise.race([
                        newPagePromise,
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 8000))
                    ]);

                    const urlFinal = novaAba.url();
                    const jogoId = urlFinal.split('/').pop();

                    if (!processados.has(jogoId)) {
                        const res = await fetch('http://127.0.0.1:3000/add-game', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({ url: urlFinal })
                        });

                        if (res.ok) {
                            console.log(`✅ [SUCESSO] Jogo ${jogoId} enviado.`);
                            processados.add(jogoId);
                            // Remove da grade para não ver mais
                            await elementoRadar.evaluate(el => {
                                const container = el.closest('div.shadow.overflow-hidden');
                                if (container) container.remove();
                            });
                        }
                    }
                    await novaAba.close();
                } catch (e) {
                    console.error(`Erro na linha ${i}: ${e.message}`);
                }

                await new Promise(r => setTimeout(r, 5000));
            }

            console.log(`[Scout] Ciclo finalizado. Pausa de 60s.`);
            await new Promise(r => setTimeout(r, 60000));
        } catch (e) {
            console.error(`Erro crítico: ${e.message}`);
            // Se der erro, só agora recarregamos a página
            await page.reload();
        }
    }
}
rodarMinerador().catch(console.error);