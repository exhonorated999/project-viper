const fs = require('fs');
const MetaWarrantParser = require('../modules/meta-warrant/meta-warrant-parser');

async function test() {
    const zipPath = 'C:\\Users\\JUSTI\\Downloads\\Clean Data Archive for Distribution[4] (1).zip';
    const buf = fs.readFileSync(zipPath);

    // Test detection
    console.log('isMetaWarrantZip:', MetaWarrantParser.isMetaWarrantZip(buf));

    // Test parsing
    const parser = new MetaWarrantParser();
    const result = await parser.parseZip(buf);

    console.log('\n=== MEDIA FILES ===');
    for (const [name, info] of Object.entries(result.mediaFiles)) {
        console.log(`  ${name}: ${info.mimeType} (${(info.size/1024).toFixed(1)} KB)`);
    }

    console.log(`\n=== RECORDS (${result.records.length}) ===`);
    for (const rec of result.records) {
        console.log(`\nSource: ${rec.source} | Service: ${rec.service}`);
        console.log(`Target: ${rec.targetId} | Account: ${rec.accountId}`);
        console.log(`Date Range: ${rec.dateRange}`);
        console.log(`Generated: ${rec.generated}`);
        console.log(`NCMEC Reports: ${rec.ncmecReports.length}`);
        console.log(`Registration IP: ${rec.registrationIp}`);
        console.log(`IP Addresses: ${rec.ipAddresses.length}`);
        if (rec.ipAddresses.length > 0) {
            rec.ipAddresses.forEach(ip => console.log(`  ${ip.ip} @ ${ip.time}`));
        }
        console.log(`About Me: ${rec.aboutMe}`);
        console.log(`Wallposts: ${rec.wallposts.length}`);
        console.log(`Status Updates: ${rec.statusUpdates.length}`);
        if (rec.statusUpdates.length > 0) {
            rec.statusUpdates.forEach(s => console.log(`  [${s.posted}] ${s.status?.substring(0, 60)} by ${s.author}`));
        }
        console.log(`Shares: ${rec.shares.length}`);
        console.log(`Photos: ${rec.photos.length}`);
        if (rec.photos.length > 0) {
            rec.photos.forEach(p => console.log(`  [${p.album}] ${p.title} — ${p.imageFile}`));
        }
        console.log(`Message Threads: ${rec.messages.threads.length}`);
        if (rec.messages.threads.length > 0) {
            rec.messages.threads.forEach(t => {
                console.log(`  Thread ${t.threadId}: ${t.participants.join(', ')}`);
                console.log(`    Messages: ${t.messages.length}`);
                t.messages.forEach(m => console.log(`      [${m.sent}] ${m.author}: ${m.body?.substring(0, 80)}`));
            });
        }
        console.log(`Posts To Other Walls: ${rec.postsToOtherWalls.length}`);
        if (rec.postsToOtherWalls.length > 0) {
            rec.postsToOtherWalls.forEach(p => console.log(`  [${p.time}] ${p.post} → ${p.timelineOwner}`));
        }
        console.log(`Bio: ${rec.bio ? rec.bio.text : null}`);
    }
}

test().catch(e => console.error('TEST ERROR:', e));
