/* 三个「可拖滑块演示」的完整写法（ch13 实例，可改成别的章）。
   读数与曲线都由公式现场算出来画，所以数据与图永远自洽；刻度坐标也要 JS 算，别写死。 */
/* ---------------- 演示 1：磁场放大器（单独 try，坏了不连累别处） ---------------- */
  try{ (function(){
    var range=document.getElementById('dA-range'),
        muEl=document.getElementById('dA-mu'),
        bar=document.getElementById('dA-bar'),
        barval=document.getElementById('dA-barval'),
        typeEl=document.getElementById('dA-type'),
        sayEl=document.getElementById('dA-say'),
        out=[document.getElementById('dA-1'),document.getElementById('dA-2'),document.getElementById('dA-3'),document.getElementById('dA-4')];
    var H=200, MU0=4*Math.PI*1e-7, B0=MU0*H;
    function sliderToMu(s){ return Math.pow(10,(s/1000)*4); }   /* 1 ~ 10000 */
    function muText(mu){
      if(mu<1) return mu.toFixed(5);
      if(mu<10) return (Math.round(mu*1000)/1000).toString();
      return String(Math.round(mu));
    }
    function render(mu){
      muEl.textContent=muText(mu);
      var B=MU0*mu*H;
      out[0].textContent=muText(mu);
      out[1].textContent=fmt(B0);
      out[2].textContent=fmt(B);
      out[3].textContent=fmt(B-B0);
      var frac=Math.min(1,(Math.log10(Math.max(mu,1))+0.2)/4.2);
      bar.setAttribute('width',String(6+frac*300));
      barval.setAttribute('x','330');
      barval.textContent='B = '+fmt(B)+' T　（×'+muText(mu)+'）';
      var t;
      if(mu<1) t='当前介质：抗磁质（μr = '+mu.toFixed(5)+'，磁场被削掉一点点）';
      else if(Math.abs(mu-1)<1e-9) t='当前介质：真空（μr = 1，毫无影响）';
      else if(mu<1.05) t='当前介质：顺磁质（μr = '+mu.toFixed(5)+'，磁场略增）';
      else t='当前介质：铁磁质 / 铁芯（μr ≈ '+Math.round(mu)+'，磁场被放大成千上万倍）';
      typeEl.textContent=t;
      if(mu>=1000) sayEl.innerHTML='注意 B₀ 那一行几乎看不见了——总磁场几乎全部来自<strong>磁化电流</strong>，传导电流那点贡献微不足道。这就是变压器里必须插铁芯的原因。';
      else if(mu<1) sayEl.innerHTML='μ<sub>r</sub> &lt; 1：抗磁质把磁场<strong>削掉了一点点</strong>。差别小到看不出来，但方向是明确的（B′ 与 B₀ 反向）。';
      else sayEl.innerHTML='再看看 B′ 那一栏：B′ = B − B₀ 正是<strong>磁化电流单独</strong>贡献的那部分磁场（B′ = μ₀M）。';
    }
    range.addEventListener('input',function(){ render(sliderToMu(+range.value)); });
    Array.prototype.forEach.call(document.querySelectorAll('#demoA .chips button'),function(b){
      b.addEventListener('click',function(){
        var mu=parseFloat(b.getAttribute('data-mu'));
        render(mu);
        range.value=String(Math.max(0,Math.min(1000,Math.round(Math.log10(Math.max(mu,1))/4*1000))));
      });
    });
    render(1);
  })(); }catch(e){ console.error('演示 1 出错：',e); }

  /* ---------------- 演示 2：同轴电缆（单独 try） ---------------- */
  try{ (function(){
    /* 单位：cm；电流 I = 10 A */
    var R1=1.0,R2=2.0,R3=3.0,I=10,MU0=4*Math.PI*1e-7,MUR=5;
    var range=document.getElementById('dB-range'), dot=document.getElementById('dB-dot'),
        line=document.getElementById('dB-line'),
        Hv=document.getElementById('dB-H'),Bv=document.getElementById('dB-B'),Mv=document.getElementById('dB-M'),
        zone=document.getElementById('dB-zone'),muEl=document.getElementById('dB-mu'),
        rval=document.getElementById('dB-rval'),Iel=document.getElementById('dB-I'),
        curve=document.getElementById('dB-curve'),cdot=document.getElementById('dB-curvedot'),
        band=document.getElementById('dB-zband');
    var CX=160,CY=140, PPC=40;            /* 40 px / cm */
    function frac(r){ return I*r/(2*Math.PI*R1*R1); }            /* A/m 的公式里 r 用 m */
    function Hof(r){                                              /* r in cm */
      if(r<=R1) return I*(r/100)/(2*Math.PI*Math.pow(R1/100,2));
      if(r<=R2) return I/(2*Math.PI*(r/100));
      if(r<=R3) return I*(R3*R3-r*r)/(2*Math.PI*(r/100)*(R3*R3-R2*R2));
      return 0;
    }
    function murOf(r){ return (r>R1&&r<=R2)?MUR:1; }
    function zoneOf(r){
      if(r<=R1) return ['芯线（导体）','μr = 1（导体不磁化）','包住了 I·r²/R₁²'];
      if(r<=R2) return ['磁介质','μr = 5','包住了全部 I'];
      if(r<=R3) return ['外导体','μr = 1','净电流 = I 减去已包住的反向电流'];
      return ['真空','μr = 1','净电流 I − I = 0'];
    }
    var Hmax=I/(2*Math.PI*(R1/100));   /* r = R1 处最大 */
    function px(r){ return 34+(r/3.6)*400; }
    function py(H){ return 120-(H/Hmax)*100; }
    /* 画曲线 */
    var d='',r=0;
    for(r=0;r<=3.62;r+=0.01){ d+=(d?'L':'M')+px(r).toFixed(1)+' '+py(Hof(r)).toFixed(1); }
    curve.setAttribute('d',d);
    band.setAttribute('x',px(R1)); band.setAttribute('width',px(R2)-px(R1));
    [[1,R1],[2,R2],[3,R3]].forEach(function(pair){
      var t=document.getElementById('dB-t'+pair[0]), l=document.getElementById('dB-l'+pair[0]);
      t.setAttribute('x1',px(pair[1])); t.setAttribute('x2',px(pair[1]));
      l.setAttribute('x',px(pair[1]));
    });
    function render(rcm){
      var rr=Math.max(0.001,rcm);
      line.setAttribute('x2',String(CX+rr*PPC));
      dot.setAttribute('cx',String(CX+rr*PPC));
      rval.textContent=rr.toFixed(2)+' cm';
      var z=zoneOf(rr), mu=murOf(rr), H=Hof(rr), B=MU0*mu*H, M=(mu-1)*H;
      zone.textContent=z[0];
      muEl.textContent=z[1];
      Iel.textContent=z[2];
      Hv.textContent=fmt(H);
      Bv.textContent=fmt(B);
      Mv.textContent=(mu===1)?'0（不磁化）':fmt(M);
      cdot.setAttribute('cx',String(px(Math.min(rr,3.6))));
      cdot.setAttribute('cy',String(py(H)));
    }
    range.addEventListener('input',function(){ render(+range.value/100); });
    render(1.5);
  })(); }catch(e){ console.error('演示 2 出错：',e); }

  /* ---------------- 演示 3：磁滞回线（单独 try） ---------------- */
  try{ (function(){
    var Bs=1.5, Hc=200, K=110, HMAX=800;
    var range=document.getElementById('dC-range'),
        dot=document.getElementById('dC-dot'), lab=document.getElementById('dC-dotlab'),
        Bv=document.getElementById('dC-Bv'), br=document.getElementById('dC-branch'),
        rel=document.getElementById('dC-rel'), BrEl=document.getElementById('dC-Br'),
        sayEl=document.getElementById('dC-say'), loop=document.getElementById('dC-loop'),
        init=document.getElementById('dC-init');
    var Br=Bs*Math.tanh(Hc/K);
    BrEl.textContent=Br.toFixed(3)+' T';
    var W=420,Hh=340, X0=211, Y0=170, XS=190/HMAX, YS=125/Bs;
    function X(H){ return X0+H*XS; }
    function Y(Bv2){ return Y0-Bv2*YS; }
    function Bup(H){ return Bs*Math.tanh((H-Hc)/K); }    /* 上升支 */
    function Bdown(H){ return Bs*Math.tanh((H+Hc)/K); }  /* 下降支 */
    function Binit(H){ return Bs*Math.tanh(H/K); }       /* 起始磁化 */
    /* 画两条支和起始曲线 */
    function path(f,a,b){ var d='',n=120; for(var i=0;i<=n;i++){ var H=a+(b-a)*i/n; d+=(i?'L':'M')+X(H).toFixed(1)+' '+Y(f(H)).toFixed(1); } return d; }
    loop.setAttribute('d',path(Bup,-HMAX,HMAX)+path(Bdown,HMAX,-HMAX));
    init.setAttribute('d',path(Binit,0,HMAX));
    var state='init', Hcur=0, dir=1;
    function render(){
      var B;
      if(state==='init') B=Binit(Hcur);
      else B=(dir<0)?Bdown(Hcur):Bup(Hcur);
      Bv.textContent=B.toFixed(3)+' T';
      br.textContent=(state==='init')?'起始磁化曲线（从未磁化过）':(dir<0?'磁滞回线 · 上支（H 正在减小）':'磁滞回线 · 下支（H 正在增大）');
      dot.setAttribute('cx',String(X(Hcur))); dot.setAttribute('cy',String(Y(B)));
      var lx=X(Hcur)+9, flip=(lx>340);            /* 靠右时标签翻到点的左边，免得越出 viewBox 被裁 */
      lab.setAttribute('x',String(flip?X(Hcur)-9:lx));
      lab.setAttribute('y',String(Y(B)-6));
      lab.setAttribute('text-anchor',flip?'end':'start');
      lab.textContent='B = '+B.toFixed(2)+' T';
      if(Hcur===0&&state!=='init'&&dir<0){
        rel.textContent='B ≠ 0，落后了！';
        sayEl.innerHTML='看这一下：H 已经回到 0，B 却停在 <strong>B<sub>r</sub> = '+B.toFixed(3)+' T</strong>——这就是剩磁，也是「磁滞」两个字的意思。';
      }else if(Math.abs(B)<0.02&&state!=='init'&&dir<0){
        rel.textContent='B ≈ 0，H = −H_c';
        sayEl.innerHTML='B 归零了，但 H 不是零，而是反向的 <strong>H<sub>c</sub> = 200 A/m</strong>。要让磁性消失，必须<strong>反着加</strong>这么强的场。';
      }else{
        rel.textContent=(state==='init')?'同步增长':'落后于 H';
        sayEl.innerHTML='同一条 H，沿起始曲线上去和沿回线下来，对应两个不同的 B——<strong>退磁不走原路</strong>，这就是磁滞损耗的来源（损耗 ∝ 回线围出的面积）。';
      }
    }
    function goto(v){
      var nH=Math.max(-HMAX,Math.min(HMAX,v));
      if(state==='init'){
        if(nH>=Hcur){ Hcur=nH; if(Hcur>=HMAX-1e-6){ state='loop'; dir=-1; } }
        else { state='loop'; dir=-1; Hcur=nH; }
      }else{
        dir=(nH<Hcur)?-1:(nH>Hcur?1:dir);
        Hcur=nH;
      }
      render();
    }
    range.addEventListener('input',function(){ goto(+range.value); });
    Array.prototype.forEach.call(document.querySelectorAll('#demoC .chips button'),function(b){
      b.addEventListener('click',function(){
        var act=b.getAttribute('data-act');
        if(act==='reset'){ state='init'; dir=1; Hcur=0; range.value='0'; render(); say('回到从未磁化过的状态，H = 0，B = 0。'); }
        else{
          state='init'; dir=1; Hcur=0; render();
          var t=0, total=160, seq=[];
          for(var i=0;i<=100;i++) seq.push(i/100*HMAX);
          for(var j=100;j>=0;j--) seq.push(-(j/100*HMAX));
          for(var k=0;k<=100;k++) seq.push(-HMAX+k/100*2*HMAX);
          var iv=setInterval(function(){
            t++; if(t>=seq.length){ clearInterval(iv); return; }
            range.value=String(seq[t]); goto(seq[t]);
          },26);
        }
      });
    });
    render();
  })(); }catch(e){ console.error('演示 3 出错：',e); }

  