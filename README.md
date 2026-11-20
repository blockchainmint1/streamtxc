# streamTXC

Okay, so in our IskanderNetwork.com project we're talking about IPFS-hosted videos, Content Delivery and video streaming.

How about we built a platform like D.tube that runs on TXC chain that does this?

Don't worry so much about alllll that for now, but imagine if we could figure out how to:

a) host videos in IPFS on a pin service like pinata.cloud
b) use a simple web-based player like HLS.js or Video.js or something else to stream
c) who and where does the transcoding happen?
d) 

We could build something like video.texitcoin.org for online video sharing and streaming:

1) people pay in TXC based on the file size for hosting
2) we timestamp the video CID or hash to the TXC chain for ownership provability
3) if the video is successful and gets views, we continue to host it
4) if the video dies, we expire the pin/hosting or charge more for it
5) we develop a play to earn model so that videos that are popular has a reward for the content creator, either in hosting credits or hash power or something

So this is the idea. What i don't know is the embed process or player, how the transcoding happens. I mean, storing an mp4 on IPFS is easy enough, but making it really optomized for streaming is beyond me (but not you!).

I'd like to avoid account creation (username/password), and have it all doable without a login. Just upload your video, pay the fee, prove ownership with your wallet, get notified if the credits are running out. 

We give people an embed player code to copy and use, with some customization options (mute, auto-play, start at time, size).

Also, the video management (either on the video page or in a management portal) shows some meta data - the IPFS hash, link to a block where it was first recorded, views (not sure if we can track views if it's not served up through our player), timestamp, etc etc.

What do you think?!

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://streamtxc.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/d4d0978e-e0a5-482f-8316-fceaa9ec6a46).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
