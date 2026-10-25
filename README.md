# Urna TikTok (13 x 22)

Cada presente mapeado soma votos para um candidato. Rosa vermelha (Rose) soma para o 13 e Rosa branca (White Rose) soma para o 22. Dá para trocar tudo no painel.

## Publicar na nuvem (para usar só com iPhone)
1. Crie uma conta grátis em https://render.com e outra em https://github.com
2. Suba esta pasta para um repositório no GitHub.
3. No Render: New > Web Service > escolha o repositório.
   - Build Command: npm install
   - Start Command: npm start
   - Em Environment, crie a variável ADMIN_KEY com uma senha sua.
4. Quando terminar, o Render dá um endereço, ex: https://sua-urna.onrender.com
   - Painel: /admin.html
   - Urna (tela da live): /game.html

## No dia da live (iPhone)
1. Abra a live no TikTok.
2. No Safari: abra /admin.html, digite a senha, seu @usuário e toque em Conectar.
3. Mande um presente de teste e ligue o nome dele ao candidato certo na lista "Presentes recebidos agora".
4. Abra /game.html, toque na tela para ativar o som e compartilhe a tela do iPhone na live.

## Rodar no computador
npm install && npm start (porta 3000)
