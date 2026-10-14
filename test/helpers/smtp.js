const net = require('net');

// A bare-bones SMTP client: sends each command and checks the reply code
async function smtpSend(port, { from, to, data, auth }) {
    const socket = net.connect(port, '127.0.0.1');
    let buffer = '';
    let waiting = null;
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
        buffer += chunk;
        // A reply is complete at a line like "250 text" (a space after the code, not a dash)
        const match = buffer.match(/^(?:\d{3}-.*\r\n)*(\d{3}) .*\r\n/);
        if (match && waiting) {
            const reply = { code: Number(match[1]), text: match[0] };
            buffer = buffer.slice(match[0].length);
            const resolve = waiting;
            waiting = null;
            resolve(reply);
        }
    });
    const reply = () => new Promise(resolve => { waiting = resolve; socket.emit('data', ''); });
    const command = async line => {
        socket.write(`${line}\r\n`);
        return reply();
    };

    const replies = [await reply()]; // greeting
    replies.push(await command('EHLO test.local'));
    if (auth) {
        replies.push(await command(`AUTH PLAIN ${Buffer.from(`\0${auth.user}\0${auth.pass}`).toString('base64')}`));
        if (replies[replies.length - 1].code >= 400) {
            socket.destroy();
            return replies;
        }
    }
    replies.push(await command(`MAIL FROM:<${from}>`));
    for (const recipient of to) replies.push(await command(`RCPT TO:<${recipient}>`));
    replies.push(await command('DATA'));
    replies.push(await command(`${data.replace(/\r?\n/g, '\r\n')}\r\n.`));
    await command('QUIT').catch(() => {});
    socket.destroy();
    return replies;
}

module.exports = { smtpSend };
