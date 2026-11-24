# COIN RADAR AI Backend v1

Binance herkese açık spot ve USDⓈ-M vadeli USDT paritelerini varsayılan olarak 60 saniyede bir tarar. Her piyasada en yüksek hacimli 20 pariteyi seçer, 15 dakikalık mumlarla kural tabanlı puanlama yapar ve eşik üstü fırsat adaylarını / ciddi risk uyarılarını Telegram'a yollar.

## Telegram kurulumu
1. Telegram'da @BotFather'a gidip `/newbot` yazın; bot oluşturun.
2. BotFather token'ını gizli tutun.
3. Yeni bot sohbetini açıp Start'a basın.
4. `https://api.telegram.org/botTOKEN/getUpdates` adresini açın (TOKEN yerine kendi token'ınız).
5. Yanıttaki `message.chat.id` değerini alın.
6. Hosting ortam değişkenlerine `TELEGRAM_BOT_TOKEN` ve `TELEGRAM_CHAT_ID` ekleyin. Token'ı bana veya herkese açık bir yere göndermeyin.

## Hosting
Bu klasörü GitHub deposuna yükleyin. Node.js 20+ destekleyen, sürekli çalışan bir Web Service/Worker açın.
Start command: `npm start`
Environment variables:
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `SCAN_INTERVAL_SECONDS=60`
- `ALERT_SCORE=78`
- `ALERT_COOLDOWN_HOURS=6`
- `TOP_PER_MARKET=20`

Uykuya geçen ücretsiz hosting planları 7/24 tarama için uygun değildir; always-on plan gerekir. `/health` adresi servis durumunu JSON olarak gösterir.

## Sınırlamalar
Bu bir makine öğrenmesi modeli değil, açıklanabilir kurallarla çalışan prototiptir. Skor başarı olasılığı değildir. Sadece Binance verisi kullanır; başka borsalar sonraki sürümde eklenebilir. Emir vermez, borsa API anahtarı istemez. Kalıcı disk olmayan hostinglerde yeniden başlatma sonrası alarm bekleme kayıtları sıfırlanabilir.
