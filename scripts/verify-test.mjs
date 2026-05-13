import bm from 'bitcoinjs-message';
const addr='Tp24GJYj9ZAUPW1tpEojhyrkX4F6p82nLv';
const msg='streamtxc:bafybeibb64evx4gtecpneitfslgkx4rxd6bb7kkenr75727hs5gnu5xsku:c4eee657797651c5b3a0b49a1f0e9eb2';
const sig='IMNLPqhVEwj4LKstKq323mdzAWIykkDH8wBk+I1pp4FRDWp1royQFyphhX/mKfttMGcbYyklaojdPBFZrLVDfrI=';
for(const p of ['\x19Texitcoin Signed Message:\n','\x1aTexitcoin Signed Message:\n','\x18Bitcoin Signed Message:\n']){
  for(const s of [true,false]){
    try{ const r=bm.verify(msg,addr,sig,p,s); console.log(JSON.stringify(p),s,'->',r);}catch(e){console.log(JSON.stringify(p),s,'ERR',e.message);}
  }
}
