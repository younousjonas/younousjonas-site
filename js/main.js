(function(){
  function clamp(n, min, max){ return Math.max(min, Math.min(max, n)); }

  function interpretSubrun(score){
    var s = clamp(score, 0, 100);
    if (s <= 25){
      return {
        label: "0–25",
        title: "Ce nœud n'est pas significatif dans ton fonctionnement actuel.",
        body: "Quelques traces peuvent exister, mais ce n'est pas un moteur principal de tes décisions et réactions."
      };
    }
    if (s <= 50){
      return {
        label: "26–50",
        title: "Quelques mécanismes sont présents, sans dominer ta vie.",
        body: "Tu peux les reconnaître par moments, puis revenir à un fonctionnement plus libre."
      };
    }
    if (s <= 75){
      return {
        label: "51–75",
        title: "Ce nœud influence significativement tes choix, réactions et blocages.",
        body: "Reconnaître la condition permet déjà d'arrêter de la confondre avec une fatalité."
      };
    }
    return {
      label: "76–100",
      title: "Ce nœud structure profondément ton fonctionnement.",
      body: "Tu peux opérer depuis cette condition sans nécessairement t'en rendre compte. La bonne nouvelle : une condition se reconnaît, puis se choisit."
    };
  }

  function wireRangeValue(range){
    var valueEl = range.closest(".q")?.querySelector(".range-value");
    var set = function(){
      if(!valueEl) return;
      valueEl.textContent = String(range.value);
    };
    range.addEventListener("input", set);
    set();
  }

  function sumRanges(form){
    var ranges = form.querySelectorAll('input[type="range"]');
    var total = 0;
    ranges.forEach(function(r){
      total += Number(r.value || 0);
    });
    return { total: total, count: ranges.length };
  }

  function setHidden(form, name, value){
    var el = form.querySelector('input[type="hidden"][name="'+name+'"]');
    if(!el){
      el = document.createElement("input");
      el.type = "hidden";
      el.name = name;
      form.appendChild(el);
    }
    el.value = String(value);
  }

  function wireSubrunForm(form){
    var resultBox = form.querySelector(".js-result");
    var noteBox = form.querySelector(".js-note");
    var btnCalc = form.querySelector(".js-calc");

    function render(){
      var x = sumRanges(form);
      var score = x.total;
      var interp = interpretSubrun(score);

      if(resultBox){
        resultBox.innerHTML =
          '<strong>Score : '+score+'/100</strong> '+
          '<span class="small" style="margin-left:10px">('+interp.label+')</span>'+
          '<p><strong>'+interp.title+'</strong> '+interp.body+'</p>';
        resultBox.style.display = "block";
      }
      if(noteBox){
        noteBox.style.display = "block";
      }

      setHidden(form, "score_total", score);
      setHidden(form, "score_band", interp.label);
      setHidden(form, "score_title", interp.title);
      return score;
    }

    if(btnCalc){
      btnCalc.addEventListener("click", function(ev){
        ev.preventDefault();
        render();
      });
    }

    form.addEventListener("submit", function(){
      render();
    });
  }

  function wireConditionForm(form){
    var resultBox = form.querySelector(".js-result");
    var btnCalc = form.querySelector(".js-calc");

    function render(){
      var v2 = 0, v2n = 0;
      var v1 = 0, v1n = 0;

      var ranges = form.querySelectorAll('input[type="range"]');
      ranges.forEach(function(r){
        var pol = r.getAttribute("data-pol") || "v2";
        if(pol === "v1"){ v1 += Number(r.value||0); v1n += 1; }
        else { v2 += Number(r.value||0); v2n += 1; }
      });

      var v2avg = v2n ? (v2 / v2n) : 0;
      var v1avg = v1n ? (v1 / v1n) : 0;

      var verdict;
      if (v2avg >= v1avg + 1.2){
        verdict = "Tu es déjà en mouvement vers l’Île V2 : la vision tient, même si des automatismes existent encore.";
      } else if (v1avg >= v2avg + 1.2){
        verdict = "Ton système opère surtout en l’Île V1 : beaucoup de choses se font en réaction. Le premier levier, c’est de reconnaître la condition.";
      } else {
        verdict = "Tu es sur une zone de bascule : tu alternes. Par moments la vision est claire, puis la réaction reprend le volant.";
      }

      if(resultBox){
        resultBox.innerHTML =
          '<p><strong>Indice Île V2 : '+v2avg.toFixed(1)+'/10</strong> · <strong>Indice Île V1 : '+v1avg.toFixed(1)+'/10</strong></p>'+
          '<p>'+verdict+'</p>'+
          '<p class="small">Si tu veux aller plus finement : explore les mini-diagnostics SUBRUN (9 nœuds). Tu peux en porter plusieurs.</p>';
        resultBox.style.display = "block";
      }

      setHidden(form, "indice_v2", v2avg.toFixed(2));
      setHidden(form, "indice_v1", v1avg.toFixed(2));
      setHidden(form, "verdict", verdict);
    }

    if(btnCalc){
      btnCalc.addEventListener("click", function(ev){
        ev.preventDefault();
        render();
      });
    }
    form.addEventListener("submit", function(){
      render();
    });
  }

  document.addEventListener("DOMContentLoaded", function(){
    document.querySelectorAll('input[type="range"]').forEach(wireRangeValue);

    document.querySelectorAll("form[data-kind='subrun']").forEach(wireSubrunForm);
    document.querySelectorAll("form[data-kind='condition']").forEach(wireConditionForm);
  });
})();