# Pike
Pike is a uni-directional path tracer leveraging WebGPU compute shaders. I made this to explore photo-realistic rendering in web browsers.  It also serves as a test-bed for me to play around with research and new browser features.

Very-loosely based on (like 99% re-written) on a previous project of mine: github.com/apbodnar/FSPT

## "Features"
* Hand-rolled GLTF loader
* A possibly correct microfacet BRDF implementation
* A novel(?) solution to importance sampling image based lights
* Okay performance
* A questionable SBVH implementation
* A very simple JSON scene format

## TODOs
* Remove image buffer jank once R/W storage images are supported in WebGPU (why is this not a thing???)
* Implement "Compressed Wide BVH" paper
* Don't use an embarassing amount of texture memory
* Experiment with shared memory based job queues to reduce thread divergence
* Importance sample-able 3D area lights (right now it's brute force MC)
* A multi-tiered BVH to facilitate GUI based scene editing
* GLTF skinning
* Explore low-discrepancy generators for quasi-RNG

## Demo
**WebGPU is very new, and at time of writing, isn't supported on Chrome for Linux** I've only tested this on a M2 MacBook and Windows + Chrome + Nvidia.  

A simple demo can be played with here: [Pike Demo](https://apbodnar.github.io/pike/?scene=tv&res=1280x720)

Move around with the W,A,S,D,R, and F keys.

## Examples

![Alt text](/screenshots/lego.png)
![Alt text](/screenshots/table.png)
![Alt text](/screenshots/room.png)
![Alt text](/screenshots/tv.png)
![Alt text](/screenshots/minecraft.png)
![Alt text](/screenshots/village.png)